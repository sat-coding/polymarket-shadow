/**
 * News-Confirmed Trading Strategy (V4)
 * 
 * CORE PRINCIPLE: Don't predict the future. Identify what ALREADY happened 
 * but the market hasn't priced in yet.
 * 
 * Flow:
 * 1. For each market, search for RECENT news (last 24h)
 * 2. Ask LLM: "Has this event already happened or been confirmed?"
 * 3. If CONFIRMED and market price still low → buy (market is slow)
 * 4. If DISCONFIRMED and market price still high → sell NO side
 * 5. If UNCERTAIN → SKIP (this is where V2/V3 lost money)
 * 
 * This changes from "predict future" to "identify stale prices"
 */

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export type NewsVerdict = {
  status: 'confirmed' | 'disconfirmed' | 'uncertain' | 'imminent';
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  newProbability: number;
  newsHeadlines: string[];
};

async function searchRecentNews(question: string): Promise<string[]> {
  const braveKey = process.env.BRAVE_API_KEY;
  if (!braveKey) return [];

  try {
    // Search for very recent news
    const query = encodeURIComponent(question);
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${query}&count=8&freshness=pd`,
      {
        headers: {
          'X-Subscription-Token': braveKey,
          'Accept': 'application/json',
        },
      }
    );

    if (!res.ok) return [];
    const data = await res.json();
    return (data?.web?.results ?? []).map(
      (r: { title: string; description?: string; url: string }) =>
        `${r.title}: ${r.description ?? ''} (${r.url})`
    );
  } catch {
    return [];
  }
}

export async function verifyMarketWithNews(
  question: string,
  currentPrice: number
): Promise<NewsVerdict> {
  const headlines = await searchRecentNews(question);
  const newsBlock = headlines.length > 0 ? headlines.join('\n') : 'No recent news found.';

  // If no recent news, immediately return uncertain
  if (headlines.length === 0) {
    return {
      status: 'uncertain',
      confidence: 'low',
      evidence: 'No recent news found — cannot verify market status.',
      newProbability: currentPrice,
      newsHeadlines: [],
    };
  }

  const prompt = `You are a news verification analyst. Your job is NOT to predict the future. Your job is to determine if the event in this market question has ALREADY HAPPENED or been OFFICIALLY CONFIRMED based on recent news.

Market question: "${question}"
Current market price (YES probability): ${currentPrice.toFixed(3)}

Recent news from the last 24 hours:
${newsBlock}

DECISION FRAMEWORK:
- "confirmed": The event HAS already happened OR has been officially announced/confirmed by credible sources. Example: "US strikes Yemen" → news shows US actually struck Yemen today.
- "disconfirmed": Credible evidence shows the event CANNOT happen within the market's timeframe. Example: "Will X happen by March 10?" and it's March 9 with zero indication.
- "imminent": Very strong signals it's about to happen (official statements, preparations confirmed) but hasn't happened yet. Only use if evidence is overwhelming.
- "uncertain": News is ambiguous, speculative, or not directly relevant. THIS SHOULD BE YOUR DEFAULT. When in doubt, say uncertain.

CRITICAL RULES:
1. "uncertain" is the SAFE answer. Use it liberally. We ONLY trade on confirmed/disconfirmed.
2. Speculation, rumors, unnamed sources, opinion pieces = "uncertain"
3. Only "confirmed" if you can point to a SPECIFIC, DATED, CREDIBLE news event
4. Market price ${currentPrice.toFixed(3)} already reflects what most people know. Only deviate if news is very recent (<24h) and clearly not priced in.

Return JSON only:
{
  "status": "confirmed|disconfirmed|uncertain|imminent",
  "confidence": "high|medium|low",
  "evidence": "Specific news headline/fact that supports your verdict, or 'No clear evidence' if uncertain",
  "newProbability": 0.XX
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      status: 'uncertain',
      confidence: 'low',
      evidence: 'Failed to parse LLM response',
      newProbability: currentPrice,
      newsHeadlines: headlines,
    };
  }

  const parsed = JSON.parse(jsonMatch[0]);
  
  // Safety: force uncertain if LLM tries to be too clever
  const status = ['confirmed', 'disconfirmed', 'imminent', 'uncertain'].includes(parsed.status)
    ? parsed.status
    : 'uncertain';
  
  return {
    status,
    confidence: parsed.confidence || 'low',
    evidence: parsed.evidence || '',
    newProbability: Math.max(0.01, Math.min(0.99, Number(parsed.newProbability) || currentPrice)),
    newsHeadlines: headlines,
  };
}
