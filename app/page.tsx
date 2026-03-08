'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';

type Outcome = { name: string; price: number };
type Market = { id: string; question: string; outcomes: Outcome[]; volume: number };
type Signal = {
  id: string; market_id: string; question: string; outcome: string;
  market_price: number; llm_estimate: number; ev: number; delta?: number | null;
  reasoning: string; news_summary: string; confidence?: string; created_at: number;
};
type Position = {
  id: string; market_id: string; question: string; outcome: string;
  entry_price: number; shares: number; entry_at: number;
  closed_at: number | null; close_price: number | null; status: 'open' | 'closed';
  current_price?: number; // enriched by server from Gamma API
};
type LogLine = { ts: number; message: string };
type PnlSnap = { ts: number; realized: number; unrealized: number; total: number };
type Portfolio = {
  cash: number; invested: number; unrealized: number; totalValue: number;
  startingCapital: number; realizedPnl: number; returnPct: number; openCount: number;
  currentDrawdownPct: number; profitFactor: number | null;
  brierScore: number | null; brierN: number; winRate: number | null; closedCount: number;
};

function PnlChart({ data }: { data: PnlSnap[] }) {
  const last = data[data.length - 1];
  const isPos = (last?.total ?? 0) >= 0;
  const color = isPos ? '#10b981' : '#ef4444';

  const chartData = data.map(d => ({
    time: new Date(d.ts * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
    total: parseFloat(d.total.toFixed(2)),
    realized: parseFloat(d.realized.toFixed(2)),
    unrealized: parseFloat(d.unrealized.toFixed(2)),
  }));

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ value: number }> }) => {
    if (!active || !payload?.length) return null;
    const v = payload[0].value;
    return (
      <div style={{ background: '#111118', border: '1px solid #2a2a3e', borderRadius: 4, padding: '6px 10px', fontFamily: 'monospace', fontSize: 11 }}>
        <span style={{ color: v >= 0 ? '#10b981' : '#ef4444' }}>{v >= 0 ? '+' : ''}${v.toFixed(2)}</span>
      </div>
    );
  };

  return (
    <div className="px-3 pt-2.5 pb-1">
      <div className="flex justify-between items-center mb-2">
        <span className="text-[10px] text-[#6b6b8a] uppercase tracking-wider font-semibold">Total P&amp;L</span>
        <div className="flex items-center gap-3">
          {last && (
            <>
              <span className="text-[10px] text-[#6b6b8a] font-mono">
                realized <span className={last.realized >= 0 ? 'text-emerald-500' : 'text-red-500'}>
                  {last.realized >= 0 ? '+' : ''}${last.realized.toFixed(2)}
                </span>
              </span>
              <span className={`font-mono text-[14px] font-semibold ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
                {isPos ? '+' : ''}${last.total.toFixed(2)}
              </span>
            </>
          )}
        </div>
      </div>

      {data.length < 2 ? (
        <div className="flex items-center justify-center text-[#6b6b8a] text-[11px] gap-2 py-6">
          <span className="opacity-30">◌</span> Accumulating data…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={90}>
          <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.2} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" hide />
            <YAxis hide domain={['auto', 'auto']} />
            <ReferenceLine y={0} stroke="#2a2a3e" strokeDasharray="3 3" />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="total"
              stroke={color}
              strokeWidth={1.5}
              fill="url(#pnlGrad)"
              dot={false}
              activeDot={{ r: 3, fill: color, strokeWidth: 0 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function evColor(ev: number) {
  const a = Math.abs(ev);
  if (a >= 0.05) return 'text-emerald-400';
  if (a >= 0.02) return 'text-yellow-400';
  return 'text-red-400';
}

function confBadge(conf?: string) {
  const map: Record<string, string> = {
    high: 'bg-emerald-950 text-emerald-400',
    medium: 'bg-yellow-950 text-yellow-400',
    low: 'bg-red-950 text-red-400',
  };
  const k = (conf ?? 'low').toLowerCase();
  return (
    <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded uppercase font-medium ${map[k] ?? map.low}`}>
      {k}
    </span>
  );
}

function trunc(s: string, n = 60) { return s.length > n ? s.slice(0, n) + '…' : s; }
function fmtTime(ts: number) { return new Date(ts * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }); }
function fmtPct(n: number) { return (n * 100).toFixed(1) + '%'; }
function signPct(n: number) { return (n >= 0 ? '+' : '') + fmtPct(n); }

export default function Dashboard() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [marketPrices, setMarketPrices] = useState<Record<string, number>>({});
  const [pnlHistory, setPnlHistory] = useState<PnlSnap[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [now, setNow] = useState(new Date());
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((msg: string) => {
    setLog(l => [...l.slice(-200), { ts: Date.now(), message: msg }]);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const loadMarkets = useCallback(async () => {
    try {
      const r = await fetch('/api/markets');
      const data = await r.json();
      setMarkets(data.slice(0, 20));
      const prices: Record<string, number> = {};
      data.forEach((m: Market) => {
        const yes = m.outcomes.find(o => o.name === 'Yes');
        if (yes) prices[m.id] = yes.price;
      });
      setMarketPrices(prices);
      // Record P&L snapshot with fresh prices
      fetch('/api/pnl', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPrices: prices }),
      }).then(() => fetch('/api/pnl').then(r => r.json()).then(setPnlHistory)).catch(() => {});
    } catch { addLog('⚠ Failed to load markets'); }
  }, [addLog]);

  const loadSignals = useCallback(async () => {
    try { const r = await fetch('/api/signals'); setSignals(await r.json()); } catch {}
  }, []);

  const loadPositions = useCallback(async () => {
    try { const r = await fetch('/api/positions'); setPositions(await r.json()); } catch {}
  }, []);

  const loadPnl = useCallback(async () => {
    try { const r = await fetch('/api/pnl'); setPnlHistory(await r.json()); } catch {}
  }, []);

  const loadPortfolio = useCallback(async () => {
    try { const r = await fetch('/api/portfolio'); setPortfolio(await r.json()); } catch {}
  }, []);

  // snapshot recorded inline in loadMarkets

  useEffect(() => {
    loadMarkets(); loadSignals(); loadPositions(); loadPnl(); loadPortfolio();
    const t = setInterval(async () => {
      await loadMarkets();
      loadPositions();
      loadPnl();
      loadPortfolio();
    }, 30000);
    return () => clearInterval(t);
  }, [loadMarkets, loadSignals, loadPositions, loadPnl, loadPortfolio]);

  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.onmessage = (e) => {
      if (e.data === 'ping') return;
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'log') addLog(ev.message);
        if (ev.type === 'signal') { loadSignals(); loadPositions(); loadPortfolio(); }
        if (ev.type === 'position') { loadPositions(); loadPortfolio(); }
      } catch {}
    };
    es.onerror = () => addLog('⚠ SSE reconnecting…');
    return () => es.close();
  }, [addLog, loadSignals, loadPositions, loadPortfolio]);

  const analyze = async (m: Market) => {
    const yes = m.outcomes.find(o => o.name === 'Yes');
    if (!yes) return;
    setAnalyzing(a => new Set(a).add(m.id));
    addLog(`→ Analyzing: ${trunc(m.question, 50)}`);
    try {
      const r = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId: m.id, question: m.question, outcome: 'Yes', price: yes.price }),
      });
      const sig = await r.json();
      addLog(`✓ EV ${signPct(sig.ev)} · ${sig.confidence}`);
      setSignals(s => [sig, ...s].slice(0, 50));
    } catch { addLog('✗ Analysis failed'); }
    finally { setAnalyzing(a => { const n = new Set(a); n.delete(m.id); return n; }); }
  };

  const openPosition = async (m: Market) => {
    const yes = m.outcomes.find(o => o.name === 'Yes');
    if (!yes) return;
    const sig = signals.find(s => s.market_id === m.id);
    const ev = sig?.ev ?? 0;
    const buyYes = ev >= 0;
    const outcome = buyYes ? 'Yes' : 'No';
    const entryPrice = buyYes ? yes.price : parseFloat((1 - yes.price).toFixed(4));
    try {
      const res = await fetch('/api/positions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketId: m.id, question: m.question, outcome, entryPrice,
          llmEstimate: sig?.llm_estimate,
        }),
      }).then(r => r.json());
      if (res.error) { addLog(`✗ ${res.error}`); return; }
      addLog(`+ Opened ${outcome} ${res.shares}sh @ ${entryPrice.toFixed(3)} ($${res.cost?.toFixed(2)})`);
      loadPositions(); loadPortfolio();
    } catch { addLog('✗ Failed to open position'); }
  };

  const closePosition = async (pos: Position) => {
    const isNo = pos.outcome?.toLowerCase() === 'no';
    const cur = pos.current_price !== undefined
      ? pos.current_price
      : marketPrices[pos.market_id] !== undefined
        ? (isNo ? 1 - marketPrices[pos.market_id] : marketPrices[pos.market_id])
        : pos.entry_price;
    try {
      await fetch(`/api/positions/${pos.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closePrice: cur }),
      });
      addLog(`✓ Closed @ ${fmtPct(cur)}`);
      loadPositions(); loadPortfolio();
    } catch {}
  };

  const openPos = positions.filter(p => p.status === 'open');

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f] text-[#e2e2f0]">

      {/* ── Header ── */}
      <header className="flex items-center justify-between px-5 h-12 border-b border-[#1e1e2e] bg-[#111118] flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-amber-400 dot-pulse shadow-[0_0_8px_#f59e0b]" />
          <span className="text-[13px] font-semibold tracking-widest uppercase text-[#e2e2f0]">Polymarket Shadow</span>
          <span className="text-[11px] text-[#6b6b8a] font-mono">paper trading · llm signals</span>
        </div>
        <div className="flex items-center gap-5">
          {portfolio && (
            <>
              <span className="text-[11px] font-mono text-[#6b6b8a]">
                💵 <span className="text-[#e2e2f0]">${portfolio.cash.toFixed(0)}</span>
              </span>
              <span className="text-[11px] font-mono">
                <span className={portfolio.returnPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {portfolio.returnPct >= 0 ? '+' : ''}{portfolio.returnPct}%
                </span>
              </span>
              {portfolio.currentDrawdownPct > 0 && (
                <span className={`text-[11px] font-mono ${portfolio.currentDrawdownPct >= 8 ? 'text-red-500' : 'text-amber-400'}`}>
                  MDD -{portfolio.currentDrawdownPct.toFixed(1)}%{portfolio.currentDrawdownPct >= 8 ? ' 🚨' : ''}
                </span>
              )}
              {portfolio.profitFactor !== null && (
                <span className="text-[11px] font-mono text-[#6b6b8a]">
                  PF <span className={portfolio.profitFactor >= 1.5 ? 'text-emerald-400' : 'text-amber-400'}>{portfolio.profitFactor.toFixed(2)}</span>
                </span>
              )}
            </>
          )}
          <span className="text-[11px] text-[#6b6b8a] font-mono">{openPos.length} open · {signals.length} signals</span>
          <span className="text-[11px] text-[#6b6b8a] font-mono">{now.toISOString().slice(0, 19)}Z</span>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: Scanner + Signals */}
        <div className="flex flex-col flex-1 overflow-hidden border-r border-[#1e1e2e]">

          {/* Scanner */}
          <div className="flex flex-col flex-1 overflow-hidden border-b border-[#1e1e2e]">
            <div className="panel-header">
              <span className="panel-label">Scanner</span>
              <span className="badge-count">{markets.length}</span>
              <span className="ml-auto text-[10px] text-[#6b6b8a] font-mono">click to analyze</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
              {markets.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-[#6b6b8a] text-xs">
                  <span className="text-2xl opacity-30">◌</span>Loading markets…
                </div>
              ) : markets.map(m => {
                const yes = m.outcomes.find(o => o.name === 'Yes');
                const sig = signals.find(s => s.market_id === m.id);
                const isAnalyzing = analyzing.has(m.id);
                return (
                  <div key={m.id}
                    className={`market-card ${isAnalyzing ? 'analyzing-card' : ''}`}
                    onClick={() => !isAnalyzing && !sig && analyze(m)}>
                    <p className="text-[12px] text-[#e2e2f0] leading-snug mb-2">{trunc(m.question)}</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      {yes && (
                        <div className="flex flex-col gap-0.5">
                          <span className="metric-label">Market p</span>
                          <span className="font-mono text-[12px] text-[#6b6b8a]">{fmtPct(yes.price)}</span>
                        </div>
                      )}
                      {sig && (
                        <>
                          <div className="flex flex-col gap-0.5">
                            <span className="metric-label">Our p̂</span>
                            <span className="font-mono text-[12px] text-[#e2e2f0]">{fmtPct(sig.llm_estimate)}</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <span className="metric-label">EV</span>
                            <span className={`font-mono text-[12px] font-medium ${evColor(sig.ev)}`}>
                              {signPct(sig.ev)}
                            </span>
                          </div>
                          {sig.delta != null && (
                            <div className="flex flex-col gap-0.5">
                              <span className="metric-label">δ</span>
                              <span className={`font-mono text-[11px] ${Math.abs(sig.delta) >= 1.5 ? 'text-emerald-400' : Math.abs(sig.delta) >= 1 ? 'text-amber-400' : 'text-[#6b6b8a]'}`}>
                                {sig.delta >= 0 ? '+' : ''}{sig.delta.toFixed(1)}σ
                              </span>
                            </div>
                          )}
                          {confBadge(sig.confidence)}
                        </>
                      )}
                      {isAnalyzing && <span className="font-mono text-[11px] text-amber-400">analyzing…</span>}
                      {!sig && !isAnalyzing && <span className="font-mono text-[10px] text-[#6b6b8a]">click to analyze</span>}
                    </div>
                    {sig && Math.abs(sig.ev) >= 0.02 && (
                      <div className="mt-2 flex gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                        <button
                          className="btn border-emerald-600 text-emerald-400 hover:bg-emerald-950"
                          onClick={() => openPosition(m)}>
                          {sig.ev > 0 ? '+ Buy YES' : '+ Buy NO'}
                        </button>
                        {portfolio && (
                          <span className="text-[10px] text-[#6b6b8a] self-center font-mono">
                            ${portfolio.cash.toFixed(0)} avail
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Signals */}
          <div className="flex flex-col" style={{ height: '220px' }}>
            <div className="panel-header">
              <span className="panel-label">Signal History</span>
              <span className="badge-count">{signals.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {signals.length === 0 ? (
                <div className="flex items-center justify-center h-full text-[#6b6b8a] text-xs gap-2">
                  <span className="opacity-30">◌</span> No signals yet
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="font-mono text-[9px] text-[#6b6b8a] uppercase tracking-wider px-2.5 py-1 border-b border-[#1e1e2e] mb-1"
                    style={{ display: 'grid', gridTemplateColumns: '70px 1fr 46px 46px 52px 48px', gap: '8px' }}>
                    <span>Time</span><span>Market</span>
                    <span className="text-right">p mkt</span>
                    <span className="text-right">p̂</span>
                    <span className="text-right">EV</span>
                    <span className="text-right">Conf</span>
                  </div>
                  {signals.map(s => (
                    <div key={s.id} className="signal-row" title={s.reasoning}>
                      <span className="font-mono text-[10px] text-[#6b6b8a]">{fmtTime(s.created_at)}</span>
                      <span className="text-[#e2e2f0] truncate">{s.question}</span>
                      <span className="font-mono text-[#6b6b8a] text-right">{fmtPct(s.market_price)}</span>
                      <span className="font-mono text-[#e2e2f0] text-right">{fmtPct(s.llm_estimate)}</span>
                      <span className={`font-mono font-medium text-right ${evColor(s.ev)}`}>{signPct(s.ev)}</span>
                      <span className="text-right">{confBadge(s.confidence)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: P&L Chart + Positions + Log */}
        <div className="flex flex-col w-80 flex-shrink-0 overflow-hidden">

          {/* Capital Stats */}
          {portfolio && (
            <div className="flex-shrink-0 border-b border-[#1e1e2e] bg-[#111118] px-3 py-2">
              {/* Row 1: main stats */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mb-2">
                <div>
                  <span className="metric-label block">Portfolio</span>
                  <span className={`font-mono text-[13px] font-semibold ${portfolio.returnPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    ${portfolio.totalValue.toFixed(0)}
                    <span className="text-[10px] ml-1 opacity-70">({portfolio.returnPct >= 0 ? '+' : ''}{portfolio.returnPct}%)</span>
                  </span>
                </div>
                <div>
                  <span className="metric-label block">Cash</span>
                  <span className="font-mono text-[13px] text-[#e2e2f0]">${portfolio.cash.toFixed(0)}</span>
                </div>
                <div>
                  <span className="metric-label block">Unrealized</span>
                  <span className={`font-mono text-[11px] ${(portfolio.unrealized ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {(portfolio.unrealized ?? 0) >= 0 ? '+' : ''}${(portfolio.unrealized ?? 0).toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="metric-label block">Realized</span>
                  <span className={`font-mono text-[11px] ${portfolio.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {portfolio.realizedPnl >= 0 ? '+' : ''}${portfolio.realizedPnl.toFixed(2)}
                  </span>
                </div>
              </div>
              {/* Row 2: performance metrics */}
              <div className="border-t border-[#1e1e2e] pt-1.5 grid grid-cols-4 gap-x-2">
                <div>
                  <span className="metric-label block">Drawdown</span>
                  <span className={`font-mono text-[11px] ${portfolio.currentDrawdownPct > 5 ? 'text-red-400' : portfolio.currentDrawdownPct > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {portfolio.currentDrawdownPct > 0 ? '-' : ''}{portfolio.currentDrawdownPct.toFixed(1)}%
                    {portfolio.currentDrawdownPct >= 8 && <span className="ml-1 text-red-500">🚨</span>}
                  </span>
                </div>
                <div>
                  <span className="metric-label block">Profit F.</span>
                  <span className={`font-mono text-[11px] ${portfolio.profitFactor === null ? 'text-[#6b6b8a]' : portfolio.profitFactor >= 1.5 ? 'text-emerald-400' : portfolio.profitFactor >= 1 ? 'text-amber-400' : 'text-red-400'}`}>
                    {portfolio.profitFactor !== null ? portfolio.profitFactor.toFixed(2) : '—'}
                  </span>
                </div>
                <div>
                  <span className="metric-label block">Brier</span>
                  <span className={`font-mono text-[11px] ${portfolio.brierScore === null ? 'text-[#6b6b8a]' : portfolio.brierScore <= 0.15 ? 'text-emerald-400' : portfolio.brierScore <= 0.25 ? 'text-amber-400' : 'text-red-400'}`}
                    title={`n=${portfolio.brierN} resolved markets`}>
                    {portfolio.brierScore !== null ? portfolio.brierScore.toFixed(3) : '—'}
                  </span>
                </div>
                <div>
                  <span className="metric-label block">Win%</span>
                  <span className={`font-mono text-[11px] ${portfolio.winRate === null ? 'text-[#6b6b8a]' : portfolio.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {portfolio.winRate !== null ? portfolio.winRate + '%' : '—'}
                    <span className="text-[9px] ml-0.5 opacity-50">({portfolio.closedCount})</span>
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* P&L Chart */}
          <div className="flex-shrink-0 border-b border-[#1e1e2e] bg-[#0d0d14]" style={{ minHeight: 155 }}>
            <PnlChart data={pnlHistory} />
          </div>

          {/* Positions */}
          <div className="flex flex-col flex-1 overflow-hidden border-b border-[#1e1e2e]">
            <div className="panel-header">
              <span className="panel-label">Positions</span>
              <span className="badge-count">{openPos.length} open</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
              {openPos.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-1.5 text-[#6b6b8a] text-xs">
                  <span className="text-2xl opacity-30">◌</span>
                  <span>No open positions</span>
                  <span className="text-[10px]">Click + Open on a signal</span>
                </div>
              ) : openPos.map(pos => {
                const isNo = pos.outcome?.toLowerCase() === 'no';
                const cur = pos.current_price !== undefined
                  ? pos.current_price
                  : marketPrices[pos.market_id] !== undefined
                    ? (isNo ? 1 - marketPrices[pos.market_id] : marketPrices[pos.market_id])
                    : pos.entry_price;
                const pnl = (cur - pos.entry_price) * pos.shares;
                const pnlPct = (cur - pos.entry_price) / pos.entry_price;
                const isProfit = pnl >= 0;
                return (
                  <div key={pos.id} className="pos-card">
                    <div className="flex justify-between items-start mb-2">
                      <p className="text-[11px] text-[#e2e2f0] leading-snug flex-1 mr-2">{trunc(pos.question, 50)}</p>
                      <span className="font-mono text-[10px] text-amber-400 flex-shrink-0">{pos.outcome}</span>
                    </div>
                    <div className="flex gap-3 mb-2">
                      <div className="flex flex-col gap-0.5">
                        <span className="metric-label">Entry</span>
                        <span className="font-mono text-[11px] text-[#6b6b8a]">{fmtPct(pos.entry_price)}</span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="metric-label">Now</span>
                        <span className="font-mono text-[11px] text-[#e2e2f0]">{fmtPct(cur)}</span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="metric-label">P&amp;L</span>
                        <span className={`font-mono text-[12px] font-medium ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
                          {isProfit ? '+' : ''}${pnl.toFixed(2)}
                          <span className="text-[10px] ml-1">({signPct(pnlPct)})</span>
                        </span>
                      </div>
                    </div>
                    <button className="btn border-red-700 text-red-400 hover:bg-red-950" onClick={() => closePosition(pos)}>
                      Close
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Log */}
          <div className="flex flex-col" style={{ height: '180px' }}>
            <div className="panel-header">
              <span className="panel-label">Agent Log</span>
              <span className="ml-auto font-mono text-[10px] text-[#6b6b8a]">live</span>
            </div>
            <div ref={logRef} className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-0.5">
              {log.length === 0
                ? <span className="text-[#6b6b8a] font-mono text-[11px]">Waiting for activity…</span>
                : log.map((l, i) => (
                  <div key={i} className="log-line">
                    <span className="text-[#6b6b8a]">{new Date(l.ts).toLocaleTimeString('en-US', { hour12: false })}</span>
                    <span className="text-[#e2e2f0]">{l.message}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
