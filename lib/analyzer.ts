import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export type AnalysisResult = {
  estimate: number;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  news_summary: string;
  news_relevant: boolean;
};

async function searchNews(question: string): Promise<string[]> {
  const braveKey = process.env.BRAVE_API_KEY;
  if (!braveKey) {
    return ['No Brave API key configured; using prior knowledge only.'];
  }

  try {
    const query = encodeURIComponent(question);
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${query}&count=5`,
      {
        headers: {
          'X-Subscription-Token': braveKey,
          'Accept': 'application/json',
        },
      }
    );

    if (!res.ok) {
      console.error('Brave search failed:', res.status);
      return [];
    }

    const data = await res.json();
    const results = data?.web?.results ?? [];
    return results.map(
      (r: { title: string; description?: string; url: string }) =>
        `${r.title}: ${r.description ?? ''} (${r.url})`
    );
  } catch (err) {
    console.error('News search error:', err);
    return [];
  }
}

export async function analyzeMarket(
  question: string,
  yesPrice: number
): Promise<AnalysisResult> {
  const headlines = await searchNews(question);
  const newsBlock =
    headlines.length > 0
      ? headlines.join('\n')
      : 'No recent news found.';

  const noNews = newsBlock === 'No recent news found.' || headlines.length === 0;

  const prompt = `You are a prediction market analyst. Assess the probability of this market resolving YES.

Market: ${question}
Current market price (implied probability): ${yesPrice.toFixed(3)}
News search results:
${newsBlock}

BASE RATE ANCHORING (do this FIRST before estimating):
1. What reference class does this event belong to? (e.g., "military strikes on nuclear facilities", "central bank rate decisions", "crypto price reaching X by date Y")
2. What is the historical base rate for this type of event? State it explicitly.
3. The current market price (${yesPrice.toFixed(3)}) reflects crowd wisdom from traders with real money. Treat it as a strong Bayesian prior.
4. Only deviate from market price if you have SPECIFIC, RECENT evidence that the crowd hasn't priced in yet.

CALIBRATION RULES (critical):
1. If the news results are irrelevant, off-topic, or empty: you have NO informational edge. Set confidence="low" and estimate within ±0.03 of the current market price. Do NOT invent probabilities.
2. Only set confidence="high" if you found 2+ directly relevant, recent news items that give you genuine edge over the market.
3. If you're unsure about specific facts: default to confidence="low".
4. State your base rate estimate BEFORE looking at market price. Then update toward market price unless you have strong evidence.
5. Overconfidence kills: when in doubt, stay closer to market price.
${noNews ? '6. NOTE: No relevant news found. Stay within ±0.03 of market price. confidence MUST be "low".' : ''}

Return JSON only: {"estimate": 0.XX, "confidence": "low|medium|high", "reasoning": "1-2 sentences citing specific evidence", "news_summary": "1 sentence", "news_relevant": true|false}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const text =
    message.content[0].type === 'text' ? message.content[0].text : '';

  // Extract JSON from response (may have markdown fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Could not parse JSON from LLM response: ${text}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    estimate: number;
    confidence: string;
    reasoning: string;
    news_summary: string;
    news_relevant?: boolean;
  };

  // Sanity check: if no news and LLM ignored calibration rules,
  // force confidence down and clamp estimate near market price
  let estimate = Math.max(0.01, Math.min(0.99, Number(parsed.estimate)));
  let confidence = (['low', 'medium', 'high'].includes(parsed.confidence)
    ? parsed.confidence
    : 'medium') as 'low' | 'medium' | 'high';
  const newsRelevant = parsed.news_relevant !== false;

  if (!newsRelevant && confidence === 'high') confidence = 'medium';
  if (!newsRelevant && Math.abs(estimate - yesPrice) > 0.08) {
    // LLM wandered too far from market with no news — hard clamp
    estimate = yesPrice + Math.sign(estimate - yesPrice) * 0.05;
  }

  return {
    estimate,
    confidence,
    reasoning: parsed.reasoning ?? '',
    news_summary: parsed.news_summary ?? '',
    news_relevant: newsRelevant,
  };
}
