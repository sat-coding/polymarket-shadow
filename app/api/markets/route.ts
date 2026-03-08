import { NextResponse } from 'next/server';
import { fetchTopMarkets } from '@/lib/polymarket';

export async function GET() {
  try {
    const markets = await fetchTopMarkets();
    return NextResponse.json(markets);
  } catch (err) {
    console.error('Markets error:', err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
