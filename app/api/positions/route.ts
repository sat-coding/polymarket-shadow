import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { emit } from '@/lib/emitter';

export const dynamic = 'force-dynamic';

async function fetchCurrentPrice(marketId: string): Promise<number | null> {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?id=${marketId}`, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data[0]?.outcomePrices) return null;
    const raw = data[0].outcomePrices;
    const prices = (typeof raw === 'string' ? JSON.parse(raw) : raw).map(Number);
    return prices[0] ?? null; // YES price
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const db = getDb();
    const positions = db.prepare(
      'SELECT * FROM positions ORDER BY entry_at DESC'
    ).all() as Array<Record<string, unknown>>;

    // Enrich open positions with current market price
    const openPositions = positions.filter(p => p.status === 'open');
    const uniqueIds = [...new Set(openPositions.map(p => p.market_id as string))];

    const priceMap: Record<string, number> = {};
    await Promise.all(
      uniqueIds.map(async id => {
        const price = await fetchCurrentPrice(id);
        if (price !== null) priceMap[id] = price;
      })
    );

    const enriched = positions.map(pos => {
      if (pos.status !== 'open') return pos;
      const currentYes = priceMap[pos.market_id as string];
      if (currentYes === undefined) return pos;
      const isNo = (pos.outcome as string)?.toLowerCase() === 'no';
      const current_price = isNo ? 1 - currentYes : currentYes;
      return { ...pos, current_price };
    });

    return NextResponse.json(enriched);
  } catch (err) {
    console.error('Get positions error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// Kelly criterion position sizing
// confidence multiplier: high=1.0, medium=0.4, low=0.1
const KELLY_CAP = 0.07;        // Max fraction per trade (must match scanner.mjs)
const MAX_POSITION_PCT = 0.07; // Max % of cash per single position

function kellyFraction(p: number, price: number, confidence: 'low'|'medium'|'high' = 'medium'): number {
  const b = (1 - price) / price;
  const q = 1 - p;
  const kelly = (p * b - q) / b;
  const confMult = confidence === 'high' ? 1.0 : confidence === 'medium' ? 0.4 : 0.1;
  return Math.max(0, Math.min(kelly * 0.25 * confMult, KELLY_CAP));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      marketId: string;
      question: string;
      outcome: string;
      entryPrice: number;
      llmEstimate?: number;
      confidence?: 'low' | 'medium' | 'high';
      shares?: number;
      halfSize?: boolean;
      maxCost?: number;
    };

    const { marketId, question, outcome, entryPrice, llmEstimate, confidence, shares: sharesOverride, halfSize, maxCost } = body;

    if (!marketId || !question || !outcome || entryPrice == null) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const db = getDb();

    // Get available cash
    const portfolio = db.prepare('SELECT cash FROM portfolio WHERE id = 1').get() as { cash: number } | undefined;
    const cash = portfolio?.cash ?? 0;

    if (cash < 1) {
      return NextResponse.json({ error: 'Insufficient capital', cash }, { status: 400 });
    }

    // Position sizing via Kelly or fixed override
    let shares: number;
    let cost: number;

    if (sharesOverride) {
      shares = sharesOverride;
      cost = entryPrice * shares;
    } else if (llmEstimate) {
      const fraction = kellyFraction(llmEstimate, entryPrice, confidence ?? 'medium');
      const betAmount = fraction * cash;
      const minBet = Math.min(5, cash); // at least $5 if we have it
      const maxBet = cash * MAX_POSITION_PCT; // never more than 7% per trade
      let finalBet = Math.max(minBet, Math.min(betAmount, maxBet));
      if (halfSize) finalBet = Math.max(minBet, finalBet * 0.5);
      // V4: respect maxCost from scanner
      if (maxCost && finalBet > maxCost) finalBet = maxCost;
      shares = Math.max(1, Math.floor(finalBet / entryPrice));
      cost = entryPrice * shares;
    } else {
      // Default: $20 flat bet
      shares = Math.max(1, Math.floor(Math.min(20, cash * 0.05) / entryPrice));
      cost = entryPrice * shares;
    }

    if (cost > cash) {
      // Scale down to what we can afford
      shares = Math.max(1, Math.floor(cash / entryPrice));
      cost = entryPrice * shares;
      if (cost > cash) {
        return NextResponse.json({ error: 'Insufficient capital for minimum position', cash }, { status: 400 });
      }
    }

    const id = crypto.randomUUID();

    db.prepare(`
      INSERT INTO positions (id, market_id, question, outcome, entry_price, shares, cost, peak_price, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `).run(id, marketId, question, outcome, entryPrice, shares, cost, entryPrice);

    // Deduct cash
    db.prepare('UPDATE portfolio SET cash = cash - ? WHERE id = 1').run(cost);

    const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(id);

    emit('position', { type: 'opened', position });
    emit('portfolio', { cash: cash - cost, invested: cost });

    return NextResponse.json(position, { status: 201 });
  } catch (err) {
    console.error('Open position error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
