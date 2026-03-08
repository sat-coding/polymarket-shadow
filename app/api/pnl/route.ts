import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

// GET — return P&L snapshot history (last 200 points)
export async function GET() {
  const db = getDb();
  const rows = db.prepare(
    'SELECT ts, realized, unrealized, total FROM pnl_snapshots ORDER BY ts ASC LIMIT 200'
  ).all();
  return NextResponse.json(rows);
}

// Fetch current YES price for a specific market from Gamma API
async function fetchMarketPrice(marketId: string): Promise<number | null> {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?id=${marketId}`, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data[0]) return null;
    const raw = data[0];
    let prices: number[] = [];
    if (typeof raw.outcomePrices === 'string') {
      prices = JSON.parse(raw.outcomePrices).map(Number);
    } else if (Array.isArray(raw.outcomePrices)) {
      prices = raw.outcomePrices.map(Number);
    }
    // Return YES price (first outcome) — convention on Polymarket
    return prices[0] ?? null;
  } catch {
    return null;
  }
}

// POST — record a P&L snapshot
// Body: { currentPrices: Record<marketId, price> } (optional — will fetch missing ones)
export async function POST(req: NextRequest) {
  const db = getDb();
  const { currentPrices = {} } = await req.json().catch(() => ({}));

  const positions = db.prepare(
    'SELECT * FROM positions'
  ).all() as Array<{
    id: string; market_id: string; entry_price: number; outcome: string;
    shares: number; close_price: number | null; status: string;
  }>;

  // Collect market IDs we're missing prices for (open positions only)
  const missingIds = positions
    .filter(p => p.status === 'open' && currentPrices[p.market_id] === undefined)
    .map(p => p.market_id)
    .filter((id, i, arr) => arr.indexOf(id) === i); // dedupe

  // Fetch missing prices in parallel
  const fetched = await Promise.all(
    missingIds.map(async id => ({ id, price: await fetchMarketPrice(id) }))
  );
  const enriched: Record<string, number> = { ...currentPrices };
  for (const { id, price } of fetched) {
    if (price !== null) enriched[id] = price;
  }

  let realized = 0;
  let unrealized = 0;

  for (const pos of positions) {
    const isNo = pos.outcome?.toLowerCase() === 'no';
    const rawCurrentYes = enriched[pos.market_id];

    let currentPrice: number;
    if (pos.status === 'closed') {
      // close_price is stored directionally (same direction as entry_price)
      currentPrice = pos.close_price ?? pos.entry_price;
    } else if (rawCurrentYes !== undefined) {
      currentPrice = isNo ? 1 - rawCurrentYes : rawCurrentYes;
    } else {
      // Still no price — keep at entry (0 PnL contribution)
      currentPrice = pos.entry_price;
    }

    const pnl = (currentPrice - pos.entry_price) * pos.shares;
    if (pos.status === 'closed') realized += pnl;
    else unrealized += pnl;
  }

  const total = realized + unrealized;
  const ts = Math.floor(Date.now() / 1000);

  db.prepare(
    'INSERT OR REPLACE INTO pnl_snapshots (ts, realized, unrealized, total) VALUES (?, ?, ?, ?)'
  ).run(ts, realized, unrealized, total);

  return NextResponse.json({ ts, realized, unrealized, total });
}
