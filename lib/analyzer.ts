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

CALIBRATION RULES (critical):
1. If the news results are irrelevant, off-topic, or empty: you have NO informational edge. Set confidence="low" and estimate within ±0.05 of the current market price. Do NOT invent probabilities.
2. Only set confidence="high" if you found 2+ directly relevant, recent news items that give you genuine edge over the market.
3. If you're unsure about specific numbers (temperatures, prices, scores): default to confidence="low".
4. The market price already reflects collective wisdom. Only deviate if you have specific evidence.
${noNews ? '5. NOTE: No relevant news found. Stay within ±0.05 of market price. confidence MUST be "low".' : ''}

Return JSON only: {"estimate": 0.XX, "confidence": "low|medium|high", "reasoning": "1-2 sentences citing specific evidence", "news_summary": "1 sentence", "news_relevant": true|false}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
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
  if (!newsRelevant && Math.abs(estimate - yesPrice) > 0.15) {
    // LLM wandered too far from market with no news — clamp it
    estimate = yesPrice + Math.sign(estimate - yesPrice) * 0.10;
  }

  return {
    estimate,
    confidence,
    reasoning: parsed.reasoning ?? '',
    news_summary: parsed.news_summary ?? '',
    news_relevant: newsRelevant,
  };
}
