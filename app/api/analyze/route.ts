import { NextRequest, NextResponse } from 'next/server';
import { analyzeMarket } from '@/lib/analyzer';
import { getDb } from '@/lib/db';
import { emit } from '@/lib/emitter';

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

    const result = await analyzeMarket(question, price);
    const ev = result.estimate - price;

    const id = crypto.randomUUID();
    const db = getDb();

    db.prepare(`
      INSERT INTO signals (id, market_id, question, outcome, market_price, llm_estimate, ev, reasoning, news_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, marketId, question, outcome, price, result.estimate, ev, result.reasoning, result.news_summary);

    const signal = {
      id,
      market_id: marketId,
      question,
      outcome,
      market_price: price,
      llm_estimate: result.estimate,
      ev,
      reasoning: result.reasoning,
      news_summary: result.news_summary,
      confidence: result.confidence,
      created_at: Math.floor(Date.now() / 1000),
    };

    emit('signal', signal);

    return NextResponse.json(signal);
  } catch (err) {
    console.error('Analyze error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
