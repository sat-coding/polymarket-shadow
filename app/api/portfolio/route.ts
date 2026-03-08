import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();

  const portfolio = db.prepare('SELECT * FROM portfolio WHERE id = 1').get() as {
    cash: number; starting_capital: number;
  } | undefined;

  const cash = portfolio?.cash ?? 1000;
  const startingCapital = portfolio?.starting_capital ?? 1000;

  const openPositions = db.prepare("SELECT * FROM positions WHERE status = 'open'").all() as Array<{
    entry_price: number; shares: number; cost: number;
  }>;

  const invested = openPositions.reduce((s, p) => s + (p.cost ?? p.entry_price * p.shares), 0);

  // Use last P&L snapshot for accurate unrealized
  const lastPnl = db.prepare(
    'SELECT unrealized, realized FROM pnl_snapshots ORDER BY ts DESC LIMIT 1'
  ).get() as { unrealized: number; realized: number } | undefined;

  const unrealized = lastPnl?.unrealized ?? 0;
  // Total = cash (already reflects realized gains) + current market value of open positions
  // current market value ≈ invested + unrealized
  const totalValue = cash + invested + unrealized;

  // close_price is stored directionally (same as entry_price direction)
  // so simple formula works for all outcomes
  const realizedPnl = db.prepare(
    "SELECT COALESCE(SUM((close_price - entry_price) * shares), 0) as pnl FROM positions WHERE status = 'closed'"
  ).get() as { pnl: number };

  return NextResponse.json({
    cash: parseFloat(cash.toFixed(2)),
    invested: parseFloat(invested.toFixed(2)),
    unrealized: parseFloat(unrealized.toFixed(2)),
    totalValue: parseFloat(totalValue.toFixed(2)),
    startingCapital,
    realizedPnl: parseFloat((realizedPnl?.pnl ?? 0).toFixed(2)),
    returnPct: parseFloat(((totalValue - startingCapital) / startingCapital * 100).toFixed(2)),
    openCount: openPositions.length,
  });
}
