import { NextRequest, NextResponse } from 'next/server';
import { analyzeMarket } from '@/lib/analyzer';
import { getDb } from '@/lib/db';
import { emit } from '@/lib/emitter';
import { estimateWeatherProbability } from '@/lib/weather-oracle';
import { classifyMarket } from '@/lib/domain-filter';

export const dynamic = 'force-dynamic';

// Compute δ mispricing score = (p_model - p_mkt) / σ_historical
// σ = std dev of past EVs. Requires ≥ 5 signals for meaningful result.
function computeDelta(ev: number, db: ReturnType<typeof getDb>): number | null {
  const rows = db.prepare(
    'SELECT ev FROM signals WHERE ev IS NOT NULL ORDER BY created_at DESC LIMIT 100'
  ).all() as Array<{ ev: number }>;

  if (rows.length < 5) return null; // not enough data yet

  const evs = rows.map(r => r.ev);
  const mean = evs.reduce((a, b) => a + b, 0) / evs.length;
  const variance = evs.reduce((s, e) => s + (e - mean) ** 2, 0) / evs.length;
  const sigma = Math.sqrt(variance);

  if (sigma < 0.001) return null; // degenerate
  return parseFloat(((ev - mean) / sigma).toFixed(3));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      marketId: string;
      question: string;
      outcome: string;
      price: number;
    };

    const { marketId, question, outcome, price } = body;

    if (!marketId || !question || price == null) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Route weather markets to data oracle (no LLM needed)
    const domain = classifyMarket(question);
    let result: { estimate: number; reasoning: string; news_summary: string; confidence: string; news_relevant: boolean };

    if (domain === 'weather') {
      const weatherResult = await estimateWeatherProbability(question);
      if (weatherResult) {
        result = {
          estimate: weatherResult.probability,
          reasoning: `[WEATHER ORACLE] ${weatherResult.reasoning}`,
          news_summary: `GFS forecast for ${weatherResult.city} on ${weatherResult.date}: high=${weatherResult.forecast.highC}°C low=${weatherResult.forecast.lowC}°C`,
          confidence: weatherResult.confidence,
          news_relevant: true, // weather data is always "relevant"
        };
      } else {
        // Couldn't parse weather question, fall back to LLM
        result = await analyzeMarket(question, price);
      }
    } else {
      result = await analyzeMarket(question, price);
    }

    const ev = result.estimate - price;

    const db = getDb();
    const delta = computeDelta(ev, db);

    const id = crypto.randomUUID();

    db.prepare(`
      INSERT INTO signals
        (id, market_id, question, outcome, market_price, llm_estimate, ev, reasoning, news_summary, confidence, delta, news_relevant)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, marketId, question, outcome, price,
      result.estimate, ev, result.reasoning, result.news_summary,
      result.confidence, delta, result.news_relevant ? 1 : 0
    );

    const signal = {
      id,
      market_id: marketId,
      question,
      outcome,
      market_price: price,
      llm_estimate: result.estimate,
      ev,
      delta,
      reasoning: result.reasoning,
      news_summary: result.news_summary,
      confidence: result.confidence,
      news_relevant: result.news_relevant,
      created_at: Math.floor(Date.now() / 1000),
    };

    emit('signal', signal);
    return NextResponse.json(signal);
  } catch (err) {
    console.error('Analyze error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
