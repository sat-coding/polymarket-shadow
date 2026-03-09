# Polymarket Bot — Deep Research & Action Plan
*Compiled: 2026-03-09 | 4 research agents, 20+ sources*

---

## KEY FINDINGS

### 1. Only 7.6% of Polymarket wallets are profitable
- Bots captured 73% of all arbitrage profits in 2025
- $40M extracted by bot-like arbitrageurs in one year
- Simple arbitrage windows now last 2–15 seconds — we can't compete there

### 2. Weather = #1 exploitable category for retail bots
- A weather bot turned **$1K → $24K** trading London temperature markets
- Another pulled **$65K** trading NYC/London/Seoul weather
- Strategy: NOAA GFS model (85–90% accurate 1–2 days out) vs crowd gut-feel pricing
- **This is the most replicable LLM-friendly edge**

### 3. LLMs are decent but not superhuman forecasters
- Best single LLM (GPT-4.5): Brier 0.101
- Human crowd: Brier 0.096–0.149
- Superforecasters: Brier 0.023–0.081
- **Ensemble of 12+ LLMs ≈ human crowd accuracy**
- Individual LLMs are overconfident — calibration is critical

### 4. Calibration techniques that work
- **Temperature/Platt scaling** on held-out set
- **Base rate anchoring** (provide historical reference classes)
- **Ensemble aggregation** (multiple models cancel bias)
- **Showing median human forecast** → +17–28% accuracy gain
- **RAG with current news** reduces stale-prior errors

### 5. Where LLMs have real edge
- Geopolitical/macro events (base rates + reasoning)
- Regulatory/policy outcomes (legislative history)
- News sentiment scoring (fast, scalable)
- Long-horizon political questions

### 6. Where LLMs hallucinate (AVOID)
- Specific sports scores/outcomes
- Reality TV, entertainment specifics
- Short-horizon crypto price moves
- Celebrity gossip / personal life events
- Anything requiring info after training cutoff without news

### 7. Polymarket API for real money
- CLOB: off-chain matching, on-chain settlement (Polygon)
- Most markets are **fee-free** (only crypto + some sports have fees)
- Order types: GTC, GTD, FOK, FAK
- $50-100 orders on liquid markets: 0-2 ticks slippage
- py-clob-client (Python) and TypeScript client available
- Official bot repo: github.com/Polymarket/agents (2.4K stars)

### 8. Domain specialization > generalist
- Traders with 65–70% win rates operate in 2–3 specific categories
- A 65%+ win rate over 100+ trades = real edge (not luck)

---

## WHAT'S WRONG WITH OUR CURRENT BOT

| Problem | Impact | Evidence |
|---|---|---|
| **Generalist approach** | Trades everything → no domain edge | 18% win rate across random categories |
| **Single LLM (Sonnet 4.6)** | Overconfident, no ensemble correction | Trump coin: LLM confident, market was right |
| **No base rate anchoring** | LLM estimates untethered from reality | Hallucinated 95% on reality TV market |
| **No weather/data-oracle markets** | Missing highest-edge category | $0 in weather markets |
| **News search too shallow** | Brave search ≠ real-time news feed | Stale signals on breaking events |
| **Kelly on bad estimates** | Garbage in, garbage out sizing | $100 position on 13% coin flip |
| **No market age filter** | Trades old stale markets + brand new ones | Both extremes are risky |

---

## ACTION PLAN — V3 BOT

### Phase 1: Immediate Fixes (this week)
*Goal: stop bleeding, improve win rate from 18% → 40%+*

#### 1.1 Domain Focus — Pick 3 Categories
Only trade markets in these categories:
- **Weather** (temperature, precipitation — NOAA GFS data edge)
- **Geopolitics/Policy** (where LLM reasoning + news = edge)
- **Crypto price levels** (verifiable data, clear resolution)

Skip: sports outcomes, entertainment, reality TV, celebrity, science

#### 1.2 Add Base Rate Anchoring to Analyzer Prompt
```
Before estimating probability, consider:
1. What is the historical base rate for this type of event?
2. What reference class does this belong to?
3. What would a naive base-rate model predict?
4. Only deviate from base rate with strong specific evidence.
```

#### 1.3 Calibration Post-Processing
- Collect our signals vs outcomes into a calibration dataset
- Apply Platt scaling: fit sigmoid on (LLM estimate → actual outcome)
- Once we have 50+ resolved signals, retrain the scaler

#### 1.4 Tighter Confidence Filter
- Require `news_relevant = true` for ALL trades (no exceptions)
- If confidence = "medium", require EV > 0.20 (not 0.12)
- Only high confidence trades at EV > 0.12

### Phase 2: Weather Module (next week)
*Goal: replicate the $1K→$24K weather bot strategy*

#### 2.1 NOAA GFS Integration
- Fetch GFS forecast data (free API: api.weather.gov or NOAA NOMADS)
- For temperature markets: compare GFS forecast vs market price
- GFS 1-2 day accuracy: 85-90% — massive edge vs crowd gut-feel

#### 2.2 Weather Market Scanner
- Filter Polymarket for weather/temperature markets specifically
- These resolve objectively → no LLM hallucination risk
- Use data model (not LLM) for probability estimation

### Phase 3: Ensemble & Calibration (week 3)
*Goal: human-crowd-level Brier score*

#### 3.1 Multi-Model Ensemble
- Run same market through Sonnet 4.6 + Haiku + one more (Gemini Flash?)
- Take median estimate
- Research shows 12-model ensemble ≈ crowd accuracy, but even 3 helps

#### 3.2 Show Market Price to Analyzer
- Paper: showing median human forecast improves LLM accuracy 17-28%
- Feed current market price AS context (not just for EV calc)
- Prompt: "The market currently prices this at X%. Consider this as crowd wisdom. Where do you disagree and why?"

#### 3.3 Calibration Curve
- After 50+ resolved signals: fit Platt scaler
- Track calibration per category (weather vs geopolitics vs crypto)
- Recalibrate weekly

### Phase 4: Real Money Prep (week 4)
*Goal: Ready to deploy with real USDC*

#### 4.1 Switch to py-clob-client / CLOB API
- Use limit orders (GTC) to avoid slippage
- Check orderbook depth before placing orders
- Fee-free on political/weather markets (our focus)

#### 4.2 Position Management
- Fractional Kelly (quarter-Kelly, as we do now)
- Max 5% of bankroll per position (not 7%)
- Correlation check: max 3 positions in same category
- Time-to-resolution filter: skip markets resolving > 60 days out

#### 4.3 Paper→Real Transition
- Run paper + real in parallel for 2 weeks
- Start real with $200 only
- Scale up only if win rate > 50% over 30+ trades

---

## PRIORITY MATRIX

| Action | Effort | Impact | Priority |
|---|---|---|---|
| Domain focus (3 categories) | Low | High | 🔴 NOW |
| Base rate anchoring in prompt | Low | High | 🔴 NOW |
| news_relevant = required | Low | Medium | 🔴 NOW |
| Weather/NOAA module | Medium | Very High | 🟡 THIS WEEK |
| Calibration post-processing | Medium | High | 🟡 NEXT WEEK |
| Multi-model ensemble | Medium | High | 🟡 NEXT WEEK |
| Show market price to LLM | Low | Medium | 🟡 NEXT WEEK |
| CLOB API integration | High | Medium | 🔵 WEEK 3-4 |
| Real money deployment | Low | — | 🔵 WEEK 4+ |

---

## KEY REPOS TO STUDY

- **Polymarket/agents** (official, 2.4K⭐): https://github.com/Polymarket/agents
- **theSchein/pamela** (ElizaOS trading agent): https://github.com/theSchein/pamela
- **warproxxx/poly-maker** (market maker): https://github.com/warproxxx/poly-maker
- **forecastingresearch/forecastbench** (calibration benchmark): https://github.com/forecastingresearch/forecastbench
- **py-clob-client** (official Python client): https://github.com/Polymarket/py-clob-client
- **Polymarket/real-time-data-client** (WebSocket TS): https://github.com/Polymarket/real-time-data-client

## KEY PAPERS

- "Approaching Human-Level Forecasting with LMs" (NeurIPS 2024): https://arxiv.org/abs/2402.18563
- "Wisdom of the Silicon Crowd" (Science Advances 2024): https://arxiv.org/abs/2402.19379
- "ForecastBench" (2024, continuously updated): https://arxiv.org/abs/2409.19839
- LLM calibration survey (NAACL 2024): https://aclanthology.org/2024.naacl-long.366.pdf
