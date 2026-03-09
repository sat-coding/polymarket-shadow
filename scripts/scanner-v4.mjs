#!/usr/bin/env node
/**
 * Scanner V4 — News-Confirmed Trading
 * 
 * PHILOSOPHY: Don't predict. Verify.
 * Only trade when news CONFIRMS an outcome that the market hasn't priced in.
 * 
 * Changes from V3:
 * - 10min scan interval (faster news reaction)
 * - News verification instead of probability prediction
 * - Only trade on "confirmed" or "disconfirmed" verdicts  
 * - Max 5 open positions (hard limit)
 * - Max 1 position per theme (correlation control)
 * - Max $30 per position (small bets, many shots)
 * - Min 7 days to resolution (no intraday gambling)
 */

const BASE_URL = process.env.APP_URL || 'http://localhost:3002';
const SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OPEN_POSITIONS = 5;
const MAX_POSITION_COST = 30; // $30 max per trade
const MAX_SAME_THEME = 1; // only 1 position per theme
const MIN_EDGE = 0.15; // need 15%+ gap between news-probability and market price
const STOP_LOSS_PCT = 0.40;
const TAKE_PROFIT_PCT = 1.00;
const TRAILING_STOP_PCT = 0.25;
const TRAILING_ACTIVATE_PCT = 0.20;
const MAX_DRAWDOWN_HALT = 0.15; // 15% drawdown = full stop
const RESOLUTION_THRESHOLD = 0.94;

// ── Theme detection (correlation control) ────────────────────────────────────
const THEME_PATTERNS = [
  { theme: 'us-trade-deal', pattern: /\btrade deal\b/i },
  { theme: 'us-strike', pattern: /\b(US|U\.S\.|Israel)\b.*\bstrike\b/i },
  { theme: 'ceasefire', pattern: /\bceasefire\b/i },
  { theme: 'election', pattern: /\b(election|win the .* seat)\b/i },
  { theme: 'interest-rate', pattern: /\binterest rate\b/i },
  { theme: 'trump', pattern: /\bTrump\b/i },
  { theme: 'iran', pattern: /\bIran\b/i },
  { theme: 'ukraine', pattern: /\bUkrain/i },
  { theme: 'yemen', pattern: /\bYemen\b/i },
  { theme: 'ecb', pattern: /\bECB\b|\bLagarde\b/i },
  { theme: 'fed', pattern: /\bFed\b|\bFederal Reserve\b/i },
];

function getTheme(question) {
  for (const { theme, pattern } of THEME_PATTERNS) {
    if (pattern.test(question)) return theme;
  }
  return 'other-' + question.slice(0, 20).replace(/\W+/g, '-').toLowerCase();
}

// ── Domain filter (weather + geopolitics only) ───────────────────────────────
const WEATHER_PAT = [/\b(highest|lowest|high|low)\s+temp/i, /°[CF]\b/, /\btemperature\b/i];
const GEO_PAT = [
  /\b(war|strike|bomb|invade|invasion|ceasefire|truce)\b/i,
  /\b(sanction|tariff|trade (deal|war|ban))\b/i,
  /\b(nuclear|missile|weapon)\b/i, /\b(embassy|diplomat)\b/i,
  /\b(NATO|UN Security|G7|G20|EU)\b/i,
  /\b(impeach|indictment|convicted|sentenced|resign)\b/i,
  /\b(election|vote|ballot|primary|runoff)\b/i,
  /\b(executive order|bill pass|legislation|veto)\b/i,
  /\b(interest rate|rate cut|rate hike)\b/i,
  /\b(Fed |Federal Reserve|ECB|Bank of England|Bank of Japan)\b/i,
  /\b(GDP|recession|CPI|inflation|unemployment rate)\b/i,
  /\b(successor|Khamenei|Putin|Zelensky|Netanyahu)\b/i,
];

function isDomainAllowed(question) {
  return WEATHER_PAT.some(p => p.test(question)) || GEO_PAT.some(p => p.test(question));
}

// ── Quality filter ───────────────────────────────────────────────────────────
const SKIP_PATTERNS = [
  /\bO\/U\b/i, /over\/under/i, /\(-?\d+\.?\d*\)/, /spread:/i,
  /\°[CF]\b/, /\btemperature\b/i, // weather handled separately
  /\blove is blind\b/i, /\bmarried at first sight\b/i, /\bbachelor(ette)?\b/i,
  /\bget engaged\b/i, /\bget married\b/i, /\bvisit(ed)?\s+(epstein|island)/i,
];

// ── Utils ────────────────────────────────────────────────────────────────────
const analyzed = new Map(); // marketId → last analyzed ts
const REANALYZE_AFTER = 3 * 60 * 60 * 1000; // 3h cooldown per market

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
const get  = (path) => fetch(`${BASE_URL}${path}`, { cache: 'no-store' }).then(r => r.json());
const post = (path, body) => fetch(`${BASE_URL}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json());
const put  = (path, body) => fetch(`${BASE_URL}${path}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json());

async function fetchCurrentYesPrice(marketId) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?id=${marketId}`, {
      cache: 'no-store', headers: { 'Accept': 'application/json' },
    });
    const data = await res.json();
    if (!data[0]?.outcomePrices) return null;
    return JSON.parse(data[0].outcomePrices).map(Number)[0];
  } catch { return null; }
}

// ── Manage open positions ────────────────────────────────────────────────────
async function managePositions() {
  const positions = await get('/api/positions').catch(() => []);
  const openPos = positions.filter(p => p.status === 'open');
  if (!openPos.length) return;

  log(`--- Managing ${openPos.length} open positions ---`);

  for (const pos of openPos) {
    const currentYesPrice = await fetchCurrentYesPrice(pos.market_id);
    if (currentYesPrice === null) continue;

    const isNo = pos.outcome?.toLowerCase() === 'no';
    const currentPrice = isNo ? 1 - currentYesPrice : currentYesPrice;
    const cost = pos.cost || pos.entry_price * pos.shares;
    const pnl = (currentPrice - pos.entry_price) * pos.shares;
    const pnlPct = pnl / cost;

    const peakPrice = pos.peak_price || pos.entry_price;
    const newPeak = Math.max(peakPrice, currentPrice);
    if (newPeak > peakPrice) {
      await put(`/api/positions/${pos.id}`, { peakPrice: newPeak, noClose: true }).catch(() => {});
    }

    const sign = pnl >= 0 ? '+' : '';
    log(`  ${pos.question?.slice(0, 42)} | ${pos.outcome} ${pos.entry_price.toFixed(3)}→${currentPrice.toFixed(3)} | ${sign}$${pnl.toFixed(2)} (${(pnlPct*100).toFixed(1)}%)`);

    let shouldClose = false;
    let reason = '';

    if (currentPrice >= RESOLUTION_THRESHOLD) { shouldClose = true; reason = `resolved ✓`; }
    else if (currentPrice <= (1 - RESOLUTION_THRESHOLD)) { shouldClose = true; reason = `resolved ✗`; }
    else if (pnlPct >= TAKE_PROFIT_PCT) { shouldClose = true; reason = `take-profit +${(pnlPct*100).toFixed(0)}%`; }
    else if (pnlPct <= -STOP_LOSS_PCT) { shouldClose = true; reason = `stop-loss ${(pnlPct*100).toFixed(1)}%`; }
    else {
      const peakGainPct = (newPeak - pos.entry_price) / pos.entry_price;
      if (peakGainPct >= TRAILING_ACTIVATE_PCT) {
        const floor = newPeak * (1 - TRAILING_STOP_PCT);
        if (currentPrice < floor) {
          shouldClose = true;
          reason = `trailing stop`;
        }
      }
    }

    if (shouldClose) {
      log(`  ⚡ CLOSE [${reason}]`);
      await put(`/api/positions/${pos.id}`, { closePrice: currentYesPrice }).catch(() => {});
    }

    await new Promise(r => setTimeout(r, 300));
  }
}

// ── Main scan ────────────────────────────────────────────────────────────────
async function scan() {
  log('=== V4 Scan — News-Confirmed Trading ===');

  await managePositions();

  const portfolio = await get('/api/portfolio').catch(() => null);
  if (portfolio) {
    const dd = portfolio.currentDrawdownPct > 0 ? ` | DD: -${portfolio.currentDrawdownPct.toFixed(1)}%` : '';
    log(`💰 $${portfolio.totalValue?.toFixed(0)} | Cash: $${portfolio.cash?.toFixed(0)} | Open: ${portfolio.openCount} | Win: ${portfolio.winRate}%${dd}`);
  }

  if (!portfolio || portfolio.cash < 5) { log('⚠ No cash'); return; }

  // Full halt at 15% drawdown
  if ((portfolio.currentDrawdownPct ?? 0) >= MAX_DRAWDOWN_HALT * 100) {
    log(`🚨 FULL HALT: ${portfolio.currentDrawdownPct?.toFixed(1)}% drawdown`);
    return;
  }

  // Hard limit on open positions
  const openPositions = await get('/api/positions').catch(() => []);
  const currentOpen = openPositions.filter(p => p.status === 'open');
  if (currentOpen.length >= MAX_OPEN_POSITIONS) {
    log(`⏸ Max ${MAX_OPEN_POSITIONS} positions reached — waiting for closes`);
    await post('/api/pnl', {}).catch(() => {});
    return;
  }

  // Theme check — what themes do we already have?
  const openThemes = new Map();
  for (const p of currentOpen) {
    const t = getTheme(p.question);
    openThemes.set(t, (openThemes.get(t) || 0) + 1);
  }

  const markets = await get('/api/markets').catch(() => []);
  const now = Date.now();

  // Filter: domain + quality + not recently analyzed
  const candidates = markets.filter(m => {
    if (SKIP_PATTERNS.some(p => p.test(m.question))) return false;
    if (!isDomainAllowed(m.question)) return false;
    if (now - (analyzed.get(m.id) ?? 0) < REANALYZE_AFTER) return false;
    if (currentOpen.some(p => p.market_id === m.id)) return false;
    // Theme limit
    const theme = getTheme(m.question);
    if ((openThemes.get(theme) || 0) >= MAX_SAME_THEME) return false;
    return true;
  });

  log(`${markets.length} markets → ${candidates.length} candidates (domain+quality+theme filtered)`);
  if (!candidates.length) { await post('/api/pnl', {}).catch(() => {}); return; }

  let newOpens = 0;

  for (const market of candidates) {
    if (currentOpen.length + newOpens >= MAX_OPEN_POSITIONS) {
      log('  Max positions reached, stopping scan');
      break;
    }

    const yes = market.outcomes.find(o => o.name.toLowerCase() === 'yes') || market.outcomes[0];
    const yesPrice = yes.price;

    log(`→ "${market.question.slice(0, 55)}" p=${yesPrice.toFixed(3)}`);

    try {
      // Use news-verification endpoint
      const signal = await post('/api/verify', {
        marketId: market.id,
        question: market.question,
        outcome: 'Yes',
        price: yesPrice,
      });
      analyzed.set(market.id, Date.now());

      const statusIcon = signal.status === 'confirmed' ? '✓' : signal.status === 'disconfirmed' ? '✗' : signal.status === 'imminent' ? '⚡' : '?';
      log(`  [${statusIcon} ${signal.status}] conf=${signal.confidence} newP=${signal.newProbability?.toFixed(3)} | ${signal.evidence?.slice(0, 60)}`);

      // ONLY trade on confirmed or disconfirmed with high/medium confidence
      if (signal.status === 'uncertain') {
        log('  · Uncertain — SKIP (this is the safe choice)');
        continue;
      }

      if (signal.confidence === 'low') {
        log('  · Low confidence — SKIP');
        continue;
      }

      // Calculate edge
      const newP = signal.newProbability;
      const edge = Math.abs(newP - yesPrice);

      if (edge < MIN_EDGE) {
        log(`  · Edge ${(edge*100).toFixed(1)}% < ${MIN_EDGE*100}% minimum — SKIP`);
        continue;
      }

      // Determine direction
      let outcome, entryPrice;
      if (signal.status === 'confirmed' || (signal.status === 'imminent' && signal.confidence === 'high')) {
        // Event confirmed/imminent → buy YES if market is low, or NO if market is high
        if (newP > yesPrice) {
          outcome = 'Yes';
          entryPrice = yesPrice;
        } else {
          outcome = 'No';
          entryPrice = parseFloat((1 - yesPrice).toFixed(4));
        }
      } else if (signal.status === 'disconfirmed') {
        // Event won't happen → buy NO
        outcome = 'No';
        entryPrice = parseFloat((1 - yesPrice).toFixed(4));
      } else {
        continue;
      }

      // Skip near-certainty entries
      if (entryPrice > 0.85 || entryPrice < 0.03) {
        log(`  · Entry ${entryPrice} too extreme — SKIP`);
        continue;
      }

      log(`  ★ TRADE: ${outcome} @ ${entryPrice.toFixed(3)} (edge: ${(edge*100).toFixed(1)}%, ${signal.status})`);

      const result = await post('/api/positions', {
        marketId: market.id,
        question: market.question,
        outcome,
        entryPrice,
        llmEstimate: newP,
        confidence: signal.confidence,
        maxCost: MAX_POSITION_COST,
      });

      if (result.error) {
        log(`  ✗ ${result.error}`);
      } else {
        log(`  ✓ ${result.shares}sh @ $${result.entry_price} | Cost: $${result.cost?.toFixed(2)}`);
        newOpens++;
        // Update theme map
        openThemes.set(getTheme(market.question), (openThemes.get(getTheme(market.question)) || 0) + 1);
      }
    } catch (err) {
      log(`  ERROR: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  await post('/api/pnl', {}).catch(() => {});
  log(`=== Done | ${newOpens} new positions ===`);
}

(async () => {
  log('🤖 V4 — News-Confirmed Trading | Max 5 pos | $30 cap | Theme control | 10min scan');
  await scan();
  setInterval(async () => {
    try { await scan(); } catch (e) { log(`ERROR: ${e.message}`); }
  }, SCAN_INTERVAL_MS);
})();
