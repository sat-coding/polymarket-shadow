#!/usr/bin/env node
/**
 * State collector — just collects data, no decisions.
 * Output: structured JSON + last scanner log lines.
 * The reviewing agent reads this and decides what to do.
 */

import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('/home/node/.openclaw/workspace/polymarket-shadow/node_modules/better-sqlite3');

const DB_PATH  = '/home/node/.openclaw/workspace/polymarket-shadow/.data/shadow.db';
const SCAN_LOG = '/tmp/polymarket-scanner.log';

const db = new Database(DB_PATH);
const now = Math.floor(Date.now() / 1000);

const portfolio = db.prepare('SELECT * FROM portfolio WHERE id = 1').get();
const openPos   = db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY entry_at DESC").all();
const closedPos = db.prepare(`
  SELECT *, ROUND((close_price - entry_price) * shares, 2) as pnl,
  ROUND((close_price - entry_price) / entry_price * 100, 1) as pnl_pct
  FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 10
`).all();
const signals   = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 20').all();

// Enrich open positions
const enriched = openPos.map(p => ({
  ...p,
  age_hours: parseFloat(((now - p.entry_at) / 3600).toFixed(1)),
  cost: p.cost || p.entry_price * p.shares,
  peak_gain_pct: p.peak_price
    ? parseFloat(((p.peak_price - p.entry_price) / p.entry_price * 100).toFixed(1))
    : 0,
}));

// Stats
const wins    = closedPos.filter(p => p.pnl > 0);
const losses  = closedPos.filter(p => p.pnl <= 0);
const hitRate = closedPos.length ? (wins.length / closedPos.length * 100).toFixed(0) + '%' : 'n/a';
const totalPnlClosed = closedPos.reduce((s, p) => s + (p.pnl || 0), 0);

// Scanner log (last 80 lines)
let scanLog = 'not found';
try { scanLog = readFileSync(SCAN_LOG, 'utf8').split('\n').slice(-80).join('\n'); } catch {}

// Scanner code (for reference)
let scannerCode = '';
try { scannerCode = readFileSync('/home/node/.openclaw/workspace/polymarket-shadow/scripts/scanner.mjs', 'utf8'); } catch {}

const currentEv = (scannerCode.match(/const EV_THRESHOLD\s*=\s*([\d.]+)/) || [])[1];
const currentKellyCap = (scannerCode.match(/Math\.min\(kelly.*?(0\.\d+)\)/) || [])[1];

const output = {
  collected_at: new Date().toISOString(),
  portfolio: {
    cash: portfolio?.cash,
    starting_capital: portfolio?.starting_capital,
    cash_pct: portfolio ? Math.round(portfolio.cash / portfolio.starting_capital * 100) : 0,
  },
  positions: {
    open_count: openPos.length,
    total_invested: parseFloat(enriched.reduce((s, p) => s + p.cost, 0).toFixed(2)),
    open: enriched.map(p => ({
      id: p.id,
      question: p.question?.slice(0, 60),
      outcome: p.outcome,
      entry_price: p.entry_price,
      peak_price: p.peak_price,
      age_hours: p.age_hours,
      cost: parseFloat(p.cost.toFixed(2)),
      peak_gain_pct: p.peak_gain_pct,
      market_id: p.market_id,
    })),
  },
  closed: {
    count: closedPos.length,
    hit_rate: hitRate,
    total_pnl: parseFloat(totalPnlClosed.toFixed(2)),
    recent: closedPos.map(p => ({
      question: p.question?.slice(0, 60),
      outcome: p.outcome,
      entry_price: p.entry_price,
      close_price: p.close_price,
      pnl: p.pnl,
      pnl_pct: p.pnl_pct,
    })),
  },
  signals: {
    recent: signals.slice(0, 10).map(s => ({
      question: s.question?.slice(0, 55),
      outcome: s.outcome,
      market_price: s.market_price,
      llm_estimate: s.llm_estimate,
      ev: parseFloat((s.ev || 0).toFixed(3)),
      confidence: s.confidence,
    })),
  },
  bot_config: {
    ev_threshold: currentEv ? parseFloat(currentEv) : null,
    kelly_cap: currentKellyCap ? parseFloat(currentKellyCap) : null,
  },
  scanner_log_tail: scanLog,
};

console.log(JSON.stringify(output, null, 2));
