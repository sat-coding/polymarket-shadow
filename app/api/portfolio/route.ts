import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();

  const portfolio = db.prepare('SELECT * FROM portfolio WHERE id = 1').get() as {
    cash: number; starting_capital: number; peak_value: number;
  } | undefined;

  const cash = portfolio?.cash ?? 1000;
  const startingCapital = portfolio?.starting_capital ?? 1000;
  const peakValue = portfolio?.peak_value ?? startingCapital;

  const openPositions = db.prepare("SELECT * FROM positions WHERE status = 'open'").all() as Array<{
    entry_price: number; shares: number; cost: number;
  }>;

  const invested = openPositions.reduce((s, p) => s + (p.cost ?? p.entry_price * p.shares), 0);

  // Use last P&L snapshot for unrealized
  const lastPnl = db.prepare(
    'SELECT unrealized, realized FROM pnl_snapshots ORDER BY ts DESC LIMIT 1'
  ).get() as { unrealized: number; realized: number } | undefined;
  const unrealized = lastPnl?.unrealized ?? 0;

  const totalValue = cash + invested + unrealized;

  // Update peak value if we hit a new high
  if (totalValue > peakValue) {
    db.prepare('UPDATE portfolio SET peak_value = ? WHERE id = 1').run(totalValue);
  }


  // Current drawdown from peak (always >= 0; 0 means at or above peak)
  const effectivePeak = Math.max(peakValue, totalValue);
  const currentDrawdown = Math.max(0, (effectivePeak - totalValue) / effectivePeak);

  // Realized P&L (directional close_price)
  const realizedPnl = db.prepare(
    "SELECT COALESCE(SUM((close_price - entry_price) * shares), 0) as pnl FROM positions WHERE status = 'closed'"
  ).get() as { pnl: number };

  // Profit Factor = gross_profit / gross_loss
  const pf = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN (close_price - entry_price) * shares > 0
        THEN (close_price - entry_price) * shares ELSE 0 END), 0) as gross_profit,
      COALESCE(SUM(CASE WHEN (close_price - entry_price) * shares < 0
        THEN ABS((close_price - entry_price) * shares) ELSE 0 END), 0) as gross_loss
    FROM positions WHERE status = 'closed'
  `).get() as { gross_profit: number; gross_loss: number };

  const profitFactor = pf.gross_loss > 0
    ? parseFloat((pf.gross_profit / pf.gross_loss).toFixed(3))
    : pf.gross_profit > 0 ? 999 : null;

  // Brier Score (running average — lower is better, 0 = perfect calibration)
  const brierResult = db.prepare(
    'SELECT AVG(score) as avg_score, COUNT(*) as n FROM brier_scores'
  ).get() as { avg_score: number | null; n: number };

  // Win rate
  const closedStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN (close_price - entry_price) * shares > 0 THEN 1 ELSE 0 END) as wins
    FROM positions WHERE status = 'closed'
  `).get() as { total: number; wins: number };

  return NextResponse.json({
    cash: parseFloat(cash.toFixed(2)),
    invested: parseFloat(invested.toFixed(2)),
    unrealized: parseFloat(unrealized.toFixed(2)),
    totalValue: parseFloat(totalValue.toFixed(2)),
    startingCapital,
    peakValue: parseFloat(peakValue.toFixed(2)),
    realizedPnl: parseFloat((realizedPnl?.pnl ?? 0).toFixed(2)),
    returnPct: parseFloat(((totalValue - startingCapital) / startingCapital * 100).toFixed(2)),
    currentDrawdownPct: parseFloat((currentDrawdown * 100).toFixed(2)),
    openCount: openPositions.length,
    // Performance metrics
    profitFactor,
    brierScore: brierResult.avg_score !== null
      ? parseFloat(brierResult.avg_score.toFixed(4)) : null,
    brierN: brierResult.n,
    winRate: closedStats.total > 0
      ? parseFloat((closedStats.wins / closedStats.total * 100).toFixed(1)) : null,
    closedCount: closedStats.total,
  });
}
