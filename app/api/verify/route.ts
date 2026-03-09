import { NextRequest, NextResponse } from 'next/server';
import { verifyMarketWithNews } from '@/lib/news-confirmed';
import { estimateWeatherProbability } from '@/lib/weather-oracle';
import { getDb } from '@/lib/db';
import { emit } from '@/lib/emitter';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { marketId, question, outcome, price } = await req.json();

    if (!marketId || !question || price == null) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Weather markets use data oracle
    const isWeather = /\b(highest|lowest|high|low)\s+temp/i.test(question) || /°[CF]\b/.test(question);
    
    let result;
    if (isWeather) {
      const weatherResult = await estimateWeatherProbability(question);
      if (weatherResult) {
        const edge = Math.abs(weatherResult.probability - price);
        result = {
          status: edge > 0.15 ? (weatherResult.probability > price ? 'confirmed' : 'disconfirmed') : 'uncertain',
          confidence: weatherResult.confidence,
          evidence: `[WEATHER ORACLE] ${weatherResult.reasoning}`,
          newProbability: weatherResult.probability,
          newsHeadlines: [],
        };
      } else {
        result = await verifyMarketWithNews(question, price);
      }
    } else {
      result = await verifyMarketWithNews(question, price);
    }

    // Store signal
    const db = getDb();
    const id = crypto.randomUUID();
    const ev = result.newProbability - price;

    db.prepare(`
      INSERT INTO signals
        (id, market_id, question, outcome, market_price, llm_estimate, ev, reasoning, news_summary, confidence, news_relevant)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, marketId, question, outcome, price,
      result.newProbability, ev,
      `[${result.status.toUpperCase()}] ${result.evidence}`,
      result.newsHeadlines.slice(0, 2).join(' | ') || 'No news',
      result.confidence,
      result.newsHeadlines.length > 0 ? 1 : 0
    );

    const signal = {
      ...result,
      id,
      market_id: marketId,
      question,
      outcome,
      market_price: price,
      llm_estimate: result.newProbability,
      ev,
    };

    emit('signal', signal);
    return NextResponse.json(signal);
  } catch (err) {
    console.error('Verify error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
