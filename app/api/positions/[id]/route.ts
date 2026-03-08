import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { emit } from '@/lib/emitter';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json() as { closePrice?: number; peakPrice?: number; noClose?: boolean };
    const { closePrice, peakPrice, noClose } = body;

    // Peak price update only (no close)
    if (noClose && peakPrice !== undefined) {
      const db = getDb();
      db.prepare('UPDATE positions SET peak_price = ? WHERE id = ? AND status = ?')
        .run(peakPrice, id, 'open');
      return NextResponse.json({ ok: true });
    }

    if (closePrice == null) {
      return NextResponse.json({ error: 'closePrice required' }, { status: 400 });
    }

    if (closePrice == null) {
      return NextResponse.json({ error: 'closePrice required' }, { status: 400 });
    }

    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    const pos = db.prepare('SELECT * FROM positions WHERE id = ? AND status = ?').get(id, 'open') as {
      entry_price: number; shares: number; cost: number; outcome: string;
      market_id: string; question: string;
    } | undefined;

    if (!pos) {
      return NextResponse.json({ error: 'Position not found or already closed' }, { status: 404 });
    }

    // Determine actual close value
    // For YES positions: value = closePrice * shares
    // For NO positions: cost was (1 - entry_price) * shares, value = (1 - closePrice) * shares
    const isNo = pos.outcome?.toLowerCase() === 'no';
    const closeValue = isNo
      ? (1 - closePrice) * pos.shares
      : closePrice * pos.shares;

    // Store close_price in the same direction as entry_price
    // entry_price is always the position-direction price (YES price for YES, NO price for NO)
    // so close_price should also be the position-direction price
    const directionalClosePrice = isNo ? 1 - closePrice : closePrice;

    db.prepare(`
      UPDATE positions
      SET status = 'closed', close_price = ?, closed_at = ?
      WHERE id = ? AND status = 'open'
    `).run(directionalClosePrice, now, id);

    // Refund cash
    db.prepare('UPDATE portfolio SET cash = cash + ? WHERE id = 1').run(closeValue);

    // Update portfolio peak value if portfolio just hit a new high
    const portfolio = db.prepare('SELECT cash, peak_value FROM portfolio WHERE id = 1').get() as
      { cash: number; peak_value: number } | undefined;
    if (portfolio) {
      const openInvested = (db.prepare("SELECT COALESCE(SUM(cost),0) as s FROM positions WHERE status='open'").get() as {s:number}).s;
      const currentTotal = portfolio.cash + openInvested;
      if (currentTotal > (portfolio.peak_value ?? 0)) {
        db.prepare('UPDATE portfolio SET peak_value = ? WHERE id = 1').run(currentTotal);
      }
    }

    // Record Brier score if market clearly resolved (price near 0 or 1)
    const RESOLVED_THRESHOLD = 0.94;
    const isResolved = directionalClosePrice >= RESOLVED_THRESHOLD || directionalClosePrice <= (1 - RESOLVED_THRESHOLD);
    if (isResolved) {
      const signal = db.prepare(
        'SELECT llm_estimate FROM signals WHERE market_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(pos.market_id as string) as { llm_estimate: number } | undefined;

      if (signal?.llm_estimate != null) {
        // actual_outcome: did YES resolve? 1 = YES won, 0 = NO won
        // For YES position: directionalClosePrice >= 0.94 → YES won → 1
        // For NO position:  directionalClosePrice <= 0.06 → NO won (YES lost) → 0
        //                   directionalClosePrice >= 0.94 → NO lost (YES won) → 1
        // Actually: regardless of position direction, track YES outcome
        // We need the yes_close_price: for YES pos it's directionalClosePrice, for NO it's 1-directionalClosePrice
        const yesClosePrice = isNo ? 1 - directionalClosePrice : directionalClosePrice;
        const actualYesOutcome = yesClosePrice >= RESOLVED_THRESHOLD ? 1 : 0;
        const llmYesEstimate = signal.llm_estimate;
        const brierScore = (llmYesEstimate - actualYesOutcome) ** 2;

        db.prepare(`
          INSERT INTO brier_scores (id, market_id, position_id, question, llm_estimate, actual_outcome, score)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(), pos.market_id, id,
          pos.question,
          llmYesEstimate, actualYesOutcome, brierScore
        );
      }
    }

    const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
    emit('position', { type: 'closed', position });

    return NextResponse.json(position);
  } catch (err) {
    console.error('Close position error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
