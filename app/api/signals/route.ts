import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  try {
    const db = getDb();
    const signals = db.prepare(`
      SELECT * FROM signals ORDER BY created_at DESC LIMIT 50
    `).all();
    return NextResponse.json(signals);
  } catch (err) {
    console.error('Get signals error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
