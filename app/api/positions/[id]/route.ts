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

    db.prepare(`
      UPDATE positions
      SET status = 'closed', close_price = ?, closed_at = ?
      WHERE id = ? AND status = 'open'
    `).run(closePrice, now, id);

    // Refund cash: return the current market value of the position
    db.prepare('UPDATE portfolio SET cash = cash + ? WHERE id = 1').run(closeValue);

    const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
    emit('position', { type: 'closed', position });

    return NextResponse.json(position);
  } catch (err) {
    console.error('Close position error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
