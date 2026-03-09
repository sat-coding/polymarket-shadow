/**
 * Domain Focus Filter — V3
 * Only trade in categories where we have genuine edge:
 * 1. Weather (NOAA data edge)
 * 2. Geopolitics/Policy (LLM reasoning + news)
 * 3. Crypto price levels (verifiable data)
 */

const WEATHER_PATTERNS = [
  /\b(highest|lowest|high|low)\s+temp/i,
  /°[CF]\b/,
  /\btemperature\b/i,
  /\bprecipitation\b/i,
  /\binches of (rain|snow)\b/i,
  /\bsnowfall\b/i,
  /\bwill it (rain|snow)\b/i,
  /\bhurricane\b.*\b(category|landfall|make)\b/i,
  /\bheat\s*(wave|dome)\b/i,
];

const GEOPOLITICS_PATTERNS = [
  /\b(war|strike|bomb|invade|invasion|ceasefire|truce)\b/i,
  /\b(sanction|tariff|trade (deal|war|ban))\b/i,
  /\b(treaty|accord|agreement|pact)\b.*\b(sign|join|ratif)/i,
  /\b(nuclear|missile|weapon)\b/i,
  /\b(embassy|diplomat|ambassador)\b/i,
  /\b(NATO|UN Security|G7|G20|EU)\b/i,
  /\b(impeach|indictment|convicted|sentenced|resign|removed from office)\b/i,
  /\b(election|vote|ballot|primary|runoff)\b/i,
  /\b(executive order|bill pass|legislation|veto)\b/i,
  /\b(interest rate|rate cut|rate hike)\b/i,
  /\b(Fed |Federal Reserve|ECB|Bank of England|Bank of Japan|RBA)\b/i,
  /\b(GDP|recession|CPI|inflation|unemployment rate)\b/i,
  /\b(successor|Khamenei|Putin|Zelensky|Netanyahu|Modi|Xi)\b/i,
];

const CRYPTO_PRICE_PATTERNS = [
  /\b(Bitcoin|BTC)\b.*\$[\d,]+/i,
  /\b(Ethereum|ETH)\b.*\$[\d,]+/i,
  /\b(XRP|Solana|SOL|Dogecoin|DOGE)\b.*\$[\d,]+/i,
  /\bcrypto\b.*\$[\d,]+/i,
  /\b(dip to|reach|above|below|hit)\s*\$[\d,]+/i,
  /\bmarket cap\b.*\$[\d,]+/i,
];

export type DomainCategory = 'weather' | 'geopolitics' | 'crypto' | 'skip';

export function classifyMarket(question: string): DomainCategory {
  if (WEATHER_PATTERNS.some(p => p.test(question))) return 'weather';
  if (GEOPOLITICS_PATTERNS.some(p => p.test(question))) return 'geopolitics';
  if (CRYPTO_PRICE_PATTERNS.some(p => p.test(question))) return 'crypto';
  return 'skip';
}

export function isDomainAllowed(question: string): boolean {
  return classifyMarket(question) !== 'skip';
}
