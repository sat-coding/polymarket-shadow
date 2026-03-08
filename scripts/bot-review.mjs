#!/usr/bin/env node
/**
 * Bot Review Agent
 * Runs every 2h via OpenClaw cron.
 * Collects data → analyzes → fixes issues → restarts if needed → reports to Telegram.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('/home/node/.openclaw/workspace/polymarket-shadow/node_modules/better-sqlite3');

const APP_DIR   = '/home/node/.openclaw/workspace/polymarket-shadow';
const DB_PATH   = `${APP_DIR}/.data/shadow.db`;
const SCAN_LOG  = '/tmp/polymarket-scanner.log';
const STATE_FILE = '/tmp/bot-review-state.json';

// ── Helpers ──────────────────────────────────────────────────────────────────
function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', cwd: APP_DIR }).trim(); }
  catch (e) { return `ERROR: ${e.message.slice(0, 120)}`; }
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { lastReview: 0, issues: [], fixes: [] };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Data collection ───────────────────────────────────────────────────────────
function collectData() {
  const db = new Database(DB_PATH);

  // Portfolio
  const portfolio = db.prepare('SELECT * FROM portfolio WHERE id = 1').get();

  // Open positions
  const openPos = db.prepare("SELECT * FROM positions WHERE status = 'open'").all();

  // Closed positions (last 20)
  const closedPos = db.prepare(
    "SELECT *, (close_price - entry_price) * shares as pnl, " +
    "(close_price - entry_price) / entry_price as pnl_pct " +
    "FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 20"
  ).all();

  // Recent signals (last 30)
  const signals = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 30').all();

  // Scanner log (last 150 lines)
  let scanLog = '';
  try { scanLog = readFileSync(SCAN_LOG, 'utf8').split('\n').slice(-150).join('\n'); }
  catch { scanLog = 'Log not found'; }

  // Compute stats
  const wins = closedPos.filter(p => p.pnl > 0);
  const losses = closedPos.filter(p => p.pnl <= 0);
  const hitRate = closedPos.length > 0 ? wins.length / closedPos.length : null;
  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p.pnl, 0) / losses.length : 0;

  // Avg EV by confidence
  const byConf = { high: [], medium: [], low: [] };
  signals.forEach(s => {
    const conf = s.confidence || 'medium';
    if (byConf[conf]) byConf[conf].push(s.ev || 0);
  });
  const avgEvByConf = Object.fromEntries(
    Object.entries(byConf).map(([k, v]) => [k, v.length > 0 ? v.reduce((a,b) => a+b,0)/v.length : null])
  );

  // Stuck positions (open > 12h with minimal movement)
  const now = Math.floor(Date.now() / 1000);
  const stuckPos = openPos.filter(p => {
    const ageH = (now - p.entry_at) / 3600;
    return ageH > 12 && p.peak_price && Math.abs(p.peak_price - p.entry_price) / p.entry_price < 0.05;
  });

  // Suspicious positions: very high initial EV (>40%) — possible LLM hallucination
  const suspiciousPos = openPos.filter(p => {
    const sig = signals.find(s => s.market_id === p.market_id);
    return sig && Math.abs(sig.ev) > 0.40;
  });

  // Cash burn rate: positions opened in last 24h
  const oneDayAgo = now - 86400;
  const recentOpened = openPos.filter(p => p.entry_at > oneDayAgo);
  const cashBurnedToday = recentOpened.reduce((s, p) => s + (p.cost || 0), 0);

  return {
    portfolio,
    openPos,
    closedPos,
    signals,
    scanLog,
    stats: { hitRate, avgWin, avgLoss, avgEvByConf, stuckCount: stuckPos.length, suspiciousCount: suspiciousPos.length, cashBurnedToday },
    stuckPos,
    suspiciousPos,
  };
}

// ── Analysis & scoring ────────────────────────────────────────────────────────
function analyzeData(data) {
  const issues = [];
  const { portfolio, openPos, closedPos, stats } = data;

  // 1. Too many open positions (> 12 → capital too spread)
  if (openPos.length > 12) {
    issues.push({
      severity: 'medium',
      type: 'overexposed',
      msg: `${openPos.length} open positions — capital too spread, reduce max_positions`,
    });
  }

  // 2. Cash too low (< 15% of starting capital)
  const cashPct = portfolio.cash / portfolio.starting_capital;
  if (cashPct < 0.15) {
    issues.push({
      severity: 'high',
      type: 'low_cash',
      msg: `Cash at ${(cashPct * 100).toFixed(0)}% of capital — bot may be overtrading`,
    });
  }

  // 3. Poor hit rate (< 40% after >5 closed)
  if (closedPos.length >= 5 && stats.hitRate !== null && stats.hitRate < 0.40) {
    issues.push({
      severity: 'high',
      type: 'low_hit_rate',
      msg: `Win rate ${(stats.hitRate * 100).toFixed(0)}% on ${closedPos.length} closed — signal quality poor`,
    });
  }

  // 4. Stuck positions (no movement in 12h)
  if (stats.stuckCount > 3) {
    issues.push({
      severity: 'low',
      type: 'stuck_positions',
      msg: `${stats.stuckCount} positions stuck >12h with <5% movement — consider tighter reanalyze cycle`,
    });
  }

  // 5. Suspicious high-EV positions still open
  if (stats.suspiciousCount > 2) {
    issues.push({
      severity: 'medium',
      type: 'suspicious_ev',
      msg: `${stats.suspiciousCount} positions with original EV >40% still open — LLM hallucination risk`,
    });
  }

  // 6. Return < -15% → emergency review
  const returnPct = (portfolio.cash + data.openPos.reduce((s,p) => s + (p.cost||0), 0) - portfolio.starting_capital)
    / portfolio.starting_capital;
  if (returnPct < -0.15) {
    issues.push({
      severity: 'critical',
      type: 'drawdown',
      msg: `Portfolio down ${(returnPct*100).toFixed(1)}% — consider halting new positions`,
    });
  }

  return issues;
}

// ── Automated fixes ───────────────────────────────────────────────────────────
async function applyFixes(issues, data) {
  const applied = [];

  for (const issue of issues) {
    // Fix: overexposed — tighten Kelly cap from 10% to 7%
    if (issue.type === 'overexposed') {
      const scannerPath = `${APP_DIR}/scripts/scanner.mjs`;
      let code = readFileSync(scannerPath, 'utf8');
      if (code.includes('0.10')) {
        code = code.replace(
          /Math\.max\(0, Math\.min\(kelly \* 0\.25 \* confMult, 0\.10\)\)/,
          'Math.max(0, Math.min(kelly * 0.25 * confMult, 0.07))'
        );
        writeFileSync(scannerPath, code);
        applied.push('Reduced Kelly cap: 10% → 7% (too many open positions)');
      }
    }

    // Fix: low_cash — raise EV threshold from 5% to 8%
    if (issue.type === 'low_cash') {
      const scannerPath = `${APP_DIR}/scripts/scanner.mjs`;
      let code = readFileSync(scannerPath, 'utf8');
      const evMatch = code.match(/const EV_THRESHOLD\s*=\s*([\d.]+)/);
      const currentEv = evMatch ? parseFloat(evMatch[1]) : 0.05;
      if (currentEv < 0.08) {
        code = code.replace(
          /const EV_THRESHOLD\s*=\s*[\d.]+/,
          'const EV_THRESHOLD        = 0.08'
        );
        writeFileSync(scannerPath, code);
        applied.push(`Raised EV threshold: ${(currentEv*100).toFixed(0)}% → 8% (low cash)`);
      }
    }

    // Fix: critical drawdown — pause new opens by setting threshold very high
    if (issue.type === 'drawdown') {
      const scannerPath = `${APP_DIR}/scripts/scanner.mjs`;
      let code = readFileSync(scannerPath, 'utf8');
      code = code.replace(
        /const EV_THRESHOLD\s*=\s*[\d.]+/,
        'const EV_THRESHOLD        = 0.20'
      );
      writeFileSync(scannerPath, code);
      applied.push('EMERGENCY: Raised EV threshold to 20% (portfolio drawdown >15%)');
    }
  }

  return applied;
}

function restartProcesses() {
  sh('pkill -f "scanner.mjs" 2>/dev/null || true');
  execSync('sleep 2');
  // Restart with log redirect via shell
  sh(`APP_URL=http://localhost:3002 nohup node scripts/scanner.mjs >> /tmp/polymarket-scanner.log 2>&1 &`);
  return true;
}

// ── Build report ──────────────────────────────────────────────────────────────
function buildReport(data, issues, fixes) {
  const { portfolio, openPos, closedPos, stats } = data;
  const totalValue = portfolio.cash + data.openPos.reduce((s,p) => s + (p.cost||0), 0);
  const returnPct = (totalValue - portfolio.starting_capital) / portfolio.starting_capital * 100;

  const lines = [];
  lines.push(`🤖 *Bot Review* — ${new Date().toLocaleTimeString('en', {hour:'2-digit',minute:'2-digit',hour12:false})} UTC`);
  lines.push('');
  lines.push(`💰 \`$${totalValue.toFixed(0)}\` total | ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}% return`);
  lines.push(`   Cash: $${portfolio.cash.toFixed(0)} | Open: ${openPos.length} pos`);
  if (closedPos.length > 0) {
    lines.push(`   Realized: ${portfolio.realized_pnl >= 0 ? '+' : ''}$${(closedPos.reduce((s,p)=>s+(p.pnl||0),0)).toFixed(0)} | Hit rate: ${stats.hitRate !== null ? (stats.hitRate*100).toFixed(0)+'%' : 'n/a'} (${closedPos.length} closed)`);
  }
  lines.push('');

  if (issues.length === 0 && fixes.length === 0) {
    lines.push('✅ All good — no issues detected, no changes made');
  } else {
    if (issues.length > 0) {
      lines.push('⚠️ *Issues found:*');
      issues.forEach(i => lines.push(`   [${i.severity.toUpperCase()}] ${i.msg}`));
    }
    if (fixes.length > 0) {
      lines.push('');
      lines.push('🔧 *Auto-fixed:*');
      fixes.forEach(f => lines.push(`   • ${f}`));
    }
  }

  // Top open positions P&L
  const sortedPos = [...openPos].sort((a, b) => {
    const pa = (a.peak_price || a.entry_price) - a.entry_price;
    const pb = (b.peak_price || b.entry_price) - b.entry_price;
    return pb - pa;
  }).slice(0, 3);
  if (sortedPos.length > 0) {
    lines.push('');
    lines.push('📊 *Top positions:*');
    sortedPos.forEach(p => {
      const pnl = ((p.peak_price || p.entry_price) - p.entry_price) * p.shares;
      lines.push(`   ${p.question?.slice(0,38)} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`);
    });
  }

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const state = loadState();
  state.lastReview = Date.now();

  try {
    const data = collectData();
    const issues = analyzeData(data);
    const fixes = await applyFixes(issues, data);

    let restarted = false;
    if (fixes.length > 0) {
      restarted = restartProcesses();
    }

    const report = buildReport(data, issues, fixes);
    state.lastIssues = issues;
    state.lastFixes = fixes;
    saveState(state);

    // Output report (OpenClaw cron will capture this and send to Telegram)
    console.log(report);
    if (restarted) console.log('\n_[Scanner restarted after code changes]_');

  } catch (err) {
    console.error('Review error:', err.message);
    process.exit(1);
  }
})();
