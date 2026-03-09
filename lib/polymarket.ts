export type MarketOutcome = {
  name: string;
  price: number;
};

export type Market = {
  id: string;
  question: string;
  outcomes: MarketOutcome[];
  volume: number;
};

type RawMarket = {
  id: string;
  question: string;
  volume?: number;
  volumeNum?: number;
  outcomes?: string; // JSON string or array
  outcomePrices?: string; // JSON string or array
  active?: boolean;
  closed?: boolean;
};

export async function fetchTopMarkets(): Promise<Market[]> {
  // Sort by liquidity (active market-making) not historical volume
  // Fetch more markets — domain filter (weather/geo/crypto) is strict, need wider pool
  const url =
    'https://gamma-api.polymarket.com/markets?limit=500&order=liquidity&ascending=false&active=true';

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    throw new Error(`Polymarket API error: ${res.status} ${res.statusText}`);
  }

  const data: RawMarket[] = await res.json();

  const markets: Market[] = [];

  for (const raw of data) {
    try {
      const volume = raw.volumeNum ?? raw.volume ?? 0;
      if (volume < 500) continue; // min some activity

      // Parse outcomes
      let outcomeNames: string[] = [];
      if (typeof raw.outcomes === 'string') {
        outcomeNames = JSON.parse(raw.outcomes);
      } else if (Array.isArray(raw.outcomes)) {
        outcomeNames = raw.outcomes;
      }

      // Only binary markets (2 outcomes)
      if (outcomeNames.length !== 2) continue;

      // Parse prices
      let prices: number[] = [];
      if (typeof raw.outcomePrices === 'string') {
        prices = JSON.parse(raw.outcomePrices).map((p: string) => parseFloat(p));
      } else if (Array.isArray(raw.outcomePrices)) {
        prices = (raw.outcomePrices as string[]).map((p) => parseFloat(p));
      }

      if (prices.length !== 2) continue;

      const yesPrice = prices[0];

      // Skip near-certain markets — no interesting EV to find
      if (yesPrice < 0.05 || yesPrice > 0.95) continue;

      markets.push({
        id: raw.id,
        question: raw.question,
        volume,
        outcomes: [
          { name: outcomeNames[0], price: prices[0] },
          { name: outcomeNames[1], price: prices[1] },
        ],
      });

      // Return top 100 active markets (domain filter will narrow further)
      if (markets.length >= 100) break;
    } catch {
      // skip malformed markets
    }
  }

  return markets;
}
