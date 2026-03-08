#!/usr/bin/env node
/**
 * Polymarket Bot v2 — Profit-maximizing improvements:
 *
 * 1. MARKET QUALITY FILTER: skip O/U, spreads, temperature, narrow price ranges
 * 2. CONFIDENCE-BASED KELLY: high=1.0x, medium=0.4x, low=skip
 * 3. TRAILING STOP: 30% from peak (activates after +15% gain)
 * 4. TAKE-PROFIT: close at +150% gain
 * 5. STALE POSITION RE-ANALYSIS: re-analyze every 4h, close if EV flips
 * 6. NO-NEWS CLAMP: analyzer now returns news_relevant flag; skip if not relevant + low conf
 */

const BASE_URL = process.env.APP_URL || 'http://localhost:3002';
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const EV_THRESHOLD        = 0.05;    // Min |EV| to open
const REANALYZE_AFTER     = 6 * 60 * 60 * 1000;   // Don't re-scan same market within 6h
const REANALYZE_POSITION_AFTER = 4 * 60 * 60 * 1000;  // Re-analyze open position after 4h
const RESOLUTION_THRESHOLD = 0.94;  // Auto-close if price >= 94% or <= 6%
const STOP_LOSS_PCT        = 0.50;  // Hard stop-loss at -50%
const TRAILING_STOP_PCT    = 0.30;  // Trailing stop: 30% from peak
const TRAILING_ACTIVATE_PCT = 0.15; // Trailing stop activates after +15% gain
const TAKE_PROFIT_PCT      = 1.50;  // Take-profit at +150% gain

// ── Market quality filter ────────────────────────────────────────────────────
const SKIP_PATTERNS = [
  /\bO\/U\b/i,              // Over/Under
  /over\/under/i,
  /\(-?\d+\.?\d*\)/,        // Spread: (-1.5), (+2.5)
  /spread:/i,
  /\°[CF]\b/,               // Temperature
  /\btemperature\b/i,
  /\bhighest temp/i,
  /\$[\d,]+[bBmMkK]?[-–]\$[\d,]+[bBmMkK]?/, // Narrow $ range: $700b-$710b
  /\b\d{1,4}[°]\b/,         // e.g. 24° 
  /\bhandicap:/i,
  /map handicap/i,
  /\btotals?\b.*\d+\.5/i,   // Totals 6.5, 7.5 etc
];

function isLowQualityMarket(question) {
  return SKIP_PATTERNS.some(p => p.test(question));
}

// ── Kelly criterion ──────────────────────────────────────────────────────────
function kellyFraction(p, price, confidence) {
  const b = (1 - price) / price;
  const q = 1 - p;
  const kelly = (p * b - q) / b;
  // Confidence multiplier
  const confMult = confidence === 'high' ? 1.0 : confidence === 'medium' ? 0.4 : 0.1;
  return Math.max(0, Math.min(kelly * 0.25 * confMult, 0.07));
}

// ── Utils ────────────────────────────────────────────────────────────────────
const analyzed   = new Map(); // marketId → last analyzed ts
const posReanalyzed = new Map(); // positionId → last reanalyzed ts

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
    const prices = JSON.parse(data[0].outcomePrices).map(Number);
    return prices[0];
  } catch { return null; }
}

// ── Manage open positions ────────────────────────────────────────────────────
async function manageOpenPositions() {
  const positions = await get('/api/positions').catch(() => []);
  const openPos = positions.filter(p => p.status === 'open' && p.market_id !== 'test-123');
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

    // Update peak price
    const peakPrice = pos.peak_price || pos.entry_price;
    const newPeak = Math.max(peakPrice, currentPrice);
    if (newPeak > peakPrice) {
      await put(`/api/positions/${pos.id}`, { peakPrice: newPeak, noClose: true }).catch(() => {});
    }

    const sign = pnl >= 0 ? '+' : '';
    log(`  ${pos.question?.slice(0, 42)} | ${pos.outcome} ${pos.entry_price.toFixed(3)}→${currentPrice.toFixed(3)} | ${sign}$${pnl.toFixed(2)} (${(pnlPct*100).toFixed(1)}%) peak=${newPeak.toFixed(3)}`);

    let shouldClose = false;
    let reason = '';

    // 1. Resolved in our favor
    if (currentPrice >= RESOLUTION_THRESHOLD) {
      shouldClose = true; reason = `resolved ✓ @ ${currentPrice.toFixed(3)}`;
    }
    // 2. Resolved against us
    else if (currentPrice <= (1 - RESOLUTION_THRESHOLD)) {
      shouldClose = true; reason = `resolved ✗ @ ${currentPrice.toFixed(3)}`;
    }
    // 3. Take-profit
    else if (pnlPct >= TAKE_PROFIT_PCT) {
      shouldClose = true; reason = `take-profit +${(pnlPct*100).toFixed(0)}%`;
    }
    // 4. Hard stop-loss
    else if (pnlPct <= -STOP_LOSS_PCT) {
      shouldClose = true; reason = `stop-loss ${(pnlPct*100).toFixed(1)}%`;
    }
    // 5. Trailing stop (only after +15% gain)
    else if (pnlPct >= -STOP_LOSS_PCT) {
      const peakGainPct = (newPeak - pos.entry_price) / pos.entry_price;
      if (peakGainPct >= TRAILING_ACTIVATE_PCT) {
        const trailingFloor = newPeak * (1 - TRAILING_STOP_PCT);
        if (currentPrice < trailingFloor) {
          shouldClose = true;
          reason = `trailing stop peak=${(peakGainPct*100).toFixed(0)}% floor=${(trailingFloor).toFixed(3)} cur=${currentPrice.toFixed(3)}`;
        }
      }
    }

    if (shouldClose) {
      log(`  ⚡ CLOSE [${reason}]`);
      await put(`/api/positions/${pos.id}`, { closePrice: currentYesPrice }).catch(e => log(`  ERROR close: ${e.message}`));
      continue;
    }

    // 6. Re-analyze stale positions (>4h open, not recently re-analyzed)
    const lastReanalyzed = posReanalyzed.get(pos.id) ?? 0;
    const posAge = Date.now() - pos.entry_at * 1000;
    if (posAge > REANALYZE_POSITION_AFTER && Date.now() - lastReanalyzed > REANALYZE_POSITION_AFTER) {
      log(`  🔍 Re-analyzing stale position (${(posAge / 3600000).toFixed(1)}h old)…`);
      try {
        const newSignal = await post('/api/analyze', {
          marketId: pos.market_id, question: pos.question,
          outcome: 'Yes', price: currentYesPrice,
        });
        posReanalyzed.set(pos.id, Date.now());

        const originalEv = (isNo ? currentYesPrice - 0.5 : 0.5 - currentYesPrice); // rough
        const newEv = newSignal.ev ?? (newSignal.llm_estimate - currentYesPrice);
        const posEv = isNo ? -newEv : newEv;

        log(`    New p̂=${newSignal.llm_estimate?.toFixed(3)} EV=${posEv >= 0 ? '+' : ''}${(posEv*100).toFixed(1)}% conf=${newSignal.confidence}`);

        // Close if EV has flipped strongly against us
        if (posEv < -0.10 && newSignal.confidence !== 'low') {
          log(`  ⚡ CLOSE [re-analysis: EV flipped to ${(posEv*100).toFixed(1)}%]`);
          await put(`/api/positions/${pos.id}`, { closePrice: currentYesPrice }).catch(e => log(`  ERROR: ${e.message}`));
        }
      } catch (e) { log(`  Re-analysis error: ${e.message}`); }
    }

    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Main scan ────────────────────────────────────────────────────────────────
async function scan() {
  log('=== Scan start ===');

  await manageOpenPositions();

  const portfolio = await get('/api/portfolio').catch(() => null);
  if (portfolio) {
    log(`💰 Cash: $${portfolio.cash.toFixed(2)} | Invested: $${portfolio.invested.toFixed(2)} | Total: $${portfolio.totalValue.toFixed(2)} | Return: ${portfolio.returnPct >= 0 ? '+' : ''}${portfolio.returnPct}%`);
  }

  if (!portfolio || portfolio.cash < 5) {
    log('⚠ No cash to deploy');
    await post('/api/pnl', {}).catch(() => {});
    return;
  }

  const markets = await get('/api/markets').catch(e => { log(`ERROR: ${e.message}`); return []; });
  const now = Date.now();

  // Apply quality filter FIRST
  const qualityMarkets = markets.filter(m => {
    if (isLowQualityMarket(m.question)) {
      log(`  ⊘ Skipped (low quality): ${m.question.slice(0, 55)}`);
      return false;
    }
    return true;
  });

  const toAnalyze = qualityMarkets.filter(m => now - (analyzed.get(m.id) ?? 0) > REANALYZE_AFTER);

  log(`${markets.length} markets | ${qualityMarkets.length} pass quality filter | ${toAnalyze.length} to analyze`);
  if (!toAnalyze.length) { log('=== Nothing new ==='); await post('/api/pnl', {}).catch(() => {}); return; }

  const openPositions = await get('/api/positions').catch(() => []);

  for (const market of toAnalyze) {
    const yes = market.outcomes.find(o => o.name.toLowerCase() === 'yes') || market.outcomes[0];
    const yesPrice = yes.price;
    log(`→ "${market.question.slice(0, 55)}" p=${yesPrice.toFixed(3)}`);

    try {
      const signal = await post('/api/analyze', {
        marketId: market.id, question: market.question,
        outcome: yes.name, price: yesPrice,
      });
      analyzed.set(market.id, Date.now());

      const ev = signal.ev ?? (signal.llm_estimate - yesPrice);
      const evPct = (ev * 100).toFixed(1);
      const newsTag = signal.news_relevant === false ? ' ⚠no-news' : '';
      log(`  p̂=${signal.llm_estimate?.toFixed(3)} EV=${ev >= 0 ? '+' : ''}${evPct}% conf=${signal.confidence}${newsTag}`);

      // Skip if confidence is low (no real edge)
      if (signal.confidence === 'low') {
        log('  · Low confidence, skipping');
        continue;
      }

      // Skip if no relevant news and EV seems too good (likely LLM hallucination)
      if (signal.news_relevant === false && Math.abs(ev) > 0.20) {
        log('  · No relevant news + suspicious EV → skipping');
        continue;
      }

      if (Math.abs(ev) < EV_THRESHOLD) { log('  · Below threshold'); continue; }

      if (openPositions.some(p => p.market_id === market.id && p.status === 'open')) {
        log('  · Already have position'); continue;
      }

      const buyYes = ev > 0;
      const outcome = buyYes ? 'Yes' : 'No';
      const entryPrice = buyYes ? yesPrice : parseFloat((1 - yesPrice).toFixed(4));

      log(`  ★ Opening ${outcome} @ ${entryPrice.toFixed(3)} (EV ${ev >= 0 ? '+' : ''}${evPct}% conf=${signal.confidence})`);

      const result = await post('/api/positions', {
        marketId: market.id, question: market.question,
        outcome, entryPrice, llmEstimate: signal.llm_estimate,
        confidence: signal.confidence,
      });

      if (result.error) {
        log(`  ✗ ${result.error} (cash: $${result.cash?.toFixed(2)})`);
      } else {
        log(`  ✓ ${result.shares}sh @ $${result.entry_price} | Cost: $${result.cost?.toFixed(2)}`);
      }

    } catch (err) {
      log(`  ERROR: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  await post('/api/pnl', {}).catch(() => {});
  log(`=== Done | ~$${(toAnalyze.length * 0.0008).toFixed(4)} API cost ===`);
}

(async () => {
  log(`🤖 Bot v2 — quality filter | confidence Kelly | trailing stop | take-profit | re-analysis`);
  await scan();
  setInterval(async () => {
    try { await scan(); } catch (e) { log(`ERROR: ${e.message}`); }
  }, SCAN_INTERVAL_MS);
})();
