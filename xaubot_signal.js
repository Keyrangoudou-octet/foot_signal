// US100 Signal Bot v4 - Railway / Twelve Data (Node.js)
// US100 (Nasdaq 100) - M5 - Sessions Londres + New York
// Pullback + bougie de retournement + Fibo + H1/H4 + ADX croissant + filtres scalping pro

const https = require('https');

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TWELVE_API_KEY   = process.env.TWELVE_API_KEY;

const SCAN_INTERVAL = 60; // secondes
const HTF_CACHE_TTL = 15 * 60 * 1000; // 15 min

const ACCOUNT_BALANCE    = parseFloat(process.env.ACCOUNT_BALANCE || "0");
const RISK_PERCENT       = parseFloat(process.env.RISK_PERCENT || "1.0");
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || "5");

const SESSION_LONDON_START = 8;
const SESSION_LONDON_END   = 17;
const SESSION_NY_START     = 13;
const SESSION_NY_END       = 22;

const US100_CONFIG = {
  symbol: "NDX",
  emaFast: 20,
  emaSlow: 50,
  rsiPeriod: 14,
  atrPeriod: 14,
  adxPeriod: 14,
  adxMin: 18,
  atrSlMult: 1.5,
  extMult: 1.2,
  pullbackTol: 0.5,
  minAtrPct: 0.05,
  roundStep: 100,
  roundBuffer: 0.15,
  sessionWarmupMin: 10,
  pointValuePerLot: 1, // a verifier selon specs FTMO pour USTEC
  fibLookback: 30,
  fibTolMult: 0.3,
};

// ─────────────────────────────────────────────
// HTTP HELPERS
// ─────────────────────────────────────────────

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────
// MARKET / SESSIONS
// ─────────────────────────────────────────────

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  const inLondon = hour >= SESSION_LONDON_START && hour < SESSION_LONDON_END;
  const inNY = hour >= SESSION_NY_START && hour < SESSION_NY_END;
  return inLondon || inNY;
}

function minutesSinceSessionStart() {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const elapsedLondon = (hour - SESSION_LONDON_START) * 60 + minute;
  const elapsedNY = (hour - SESSION_NY_START) * 60 + minute;
  const candidates = [elapsedLondon, elapsedNY].filter(e => e >= 0);
  if (candidates.length === 0) return 9999;
  return Math.min(...candidates);
}

// ─────────────────────────────────────────────
// CANDLES
// ─────────────────────────────────────────────

async function getCandles(symbol, interval = '5min', outputsize = 100) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVE_API_KEY}&format=JSON`;
  try {
    const data = await httpsGetJson(url);
    if (!data.values) {
      console.error('Twelve Data erreur', symbol, interval, data.message || 'unknown');
      return null;
    }
    return data.values.map(v => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    })).reverse();
  } catch (e) {
    console.error('getCandles error', symbol, interval, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// INDICATEURS
// ─────────────────────────────────────────────

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rollingMean(arr, period) {
  const out = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    let sum = 0, ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (arr[j] === null || arr[j] === undefined || Number.isNaN(arr[j])) { ok = false; break; }
      sum += arr[j];
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}

function rsi(closes, period = 14) {
  const delta = closes.map((c, i) => i === 0 ? 0 : c - closes[i - 1]);
  const gains = delta.map(d => Math.max(d, 0));
  const losses = delta.map(d => Math.max(-d, 0));
  const avgGain = rollingMean(gains, period);
  const avgLoss = rollingMean(losses, period);
  return avgGain.map((g, i) => {
    if (g === null) return null;
    const l = avgLoss[i];
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  });
}

function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

function atr(candles, period = 14) {
  return rollingMean(trueRange(candles), period);
}

function adx(candles, period = 14) {
  const plusDM = candles.map((c, i) => i === 0 ? 0 : Math.max(c.high - candles[i - 1].high, 0));
  const minusDM = candles.map((c, i) => i === 0 ? 0 : Math.max(candles[i - 1].low - c.low, 0));
  const atrRaw = rollingMean(trueRange(candles), period);
  const plusDMSmooth = rollingMean(plusDM, period);
  const minusDMSmooth = rollingMean(minusDM, period);

  const plusDI = plusDMSmooth.map((v, i) => (v === null || atrRaw[i] === null || atrRaw[i] === 0) ? null : 100 * v / atrRaw[i]);
  const minusDI = minusDMSmooth.map((v, i) => (v === null || atrRaw[i] === null || atrRaw[i] === 0) ? null : 100 * v / atrRaw[i]);

  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p === null || m === null) return null;
    const denom = p + m;
    if (denom === 0) return 0;
    return 100 * Math.abs(p - m) / denom;
  });

  return { adx: rollingMean(dx, period), plusDI, minusDI };
}

function swingLow(candles, n = 10) {
  const slice = candles.slice(-n - 1, -1);
  return Math.min(...slice.map(c => c.low));
}

function swingHigh(candles, n = 10) {
  const slice = candles.slice(-n - 1, -1);
  return Math.max(...slice.map(c => c.high));
}

// ─────────────────────────────────────────────
// FIBONACCI
// ─────────────────────────────────────────────

function getFibLevels(closed, lookback) {
  const slice = closed.slice(-lookback);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  const range = high - low;
  return {
    buyLevels: [high - range * 0.382, high - range * 0.5, high - range * 0.618],
    sellLevels: [low + range * 0.382, low + range * 0.5, low + range * 0.618],
  };
}

function matchedFibLevel(price, levels, atrNow, tolMult) {
  const labels = ['38.2%', '50%', '61.8%'];
  for (let i = 0; i < levels.length; i++) {
    if (Math.abs(price - levels[i]) <= atrNow * tolMult) return labels[i];
  }
  return null;
}

// ─────────────────────────────────────────────
// PATTERNS DE RETOURNEMENT
// ─────────────────────────────────────────────

function bullishReversalPattern(prev, curr) {
  const bodyCurr = Math.abs(curr.close - curr.open);
  const lowerWick = Math.min(curr.close, curr.open) - curr.low;
  const upperWick = curr.high - Math.max(curr.close, curr.open);
  const bullishEngulfing = curr.close > curr.open && prev.close < prev.open &&
    curr.close >= prev.open && curr.open <= prev.close;
  const hammer = curr.close > curr.open && bodyCurr > 0 &&
    lowerWick >= bodyCurr * 1.5 && upperWick <= bodyCurr * 0.5;
  return bullishEngulfing || hammer;
}

function bearishReversalPattern(prev, curr) {
  const bodyCurr = Math.abs(curr.close - curr.open);
  const lowerWick = Math.min(curr.close, curr.open) - curr.low;
  const upperWick = curr.high - Math.max(curr.close, curr.open);
  const bearishEngulfing = curr.close < curr.open && prev.close > prev.open &&
    curr.close <= prev.open && curr.open >= prev.close;
  const shootingStar = curr.close < curr.open && bodyCurr > 0 &&
    upperWick >= bodyCurr * 1.5 && lowerWick <= bodyCurr * 0.5;
  return bearishEngulfing || shootingStar;
}

function nearRoundNumber(price, step, atrNow, bufferMult) {
  const nearest = Math.round(price / step) * step;
  return Math.abs(price - nearest) <= atrNow * bufferMult;
}

// ─────────────────────────────────────────────
// TENDANCE H1 + H4 (avec cache)
// ─────────────────────────────────────────────

let htfCache = null;

async function getHtfTrend(symbol) {
  const h1 = await getCandles(symbol, '1h', 60);
  const h4 = await getCandles(symbol, '4h', 60);
  if (!h1 || h1.length < 55 || !h4 || h4.length < 55) return null;

  const f1 = ema(h1.map(c => c.close), 15).slice(-1)[0];
  const s1 = ema(h1.map(c => c.close), 50).slice(-1)[0];
  const f4 = ema(h4.map(c => c.close), 15).slice(-1)[0];
  const s4 = ema(h4.map(c => c.close), 50).slice(-1)[0];

  const h1dir = f1 > s1 ? 'BULL' : 'BEAR';
  const h4dir = f4 > s4 ? 'BULL' : 'BEAR';

  return h1dir === h4dir ? h1dir : null;
}

async function getHtfTrendCached(symbol) {
  const now = Date.now();
  if (htfCache && (now - htfCache.ts) < HTF_CACHE_TTL) return htfCache.trend;
  const trend = await getHtfTrend(symbol);
  htfCache = { ts: now, trend };
  return trend;
}

// ─────────────────────────────────────────────
// DETECTION ENTREE
// ─────────────────────────────────────────────

function detectPullbackEntry(candles, cfg) {
  const closed = candles.slice(0, -1);
  if (closed.length < Math.max(cfg.emaSlow, cfg.adxPeriod) + 10) return null;

  const closes = closed.map(c => c.close);
  const emaF = ema(closes, cfg.emaFast);
  const emaS = ema(closes, cfg.emaSlow);
  const atrArr = atr(closed, cfg.atrPeriod);
  const { adx: adxArr, plusDI, minusDI } = adx(closed, cfg.adxPeriod);

  const n = closed.length;
  const last = closed[n - 1];
  const prev = closed[n - 2];
  const emaFNow = emaF[n - 1];
  const emaSNow = emaS[n - 1];
  const atrNow = atrArr[n - 1];
  const adxNow = adxArr[n - 1];
  const adxPrev = adxArr[n - 4];
  const plusNow = plusDI[n - 1];
  const minusNow = minusDI[n - 1];

  if ([emaFNow, emaSNow, atrNow, adxNow, adxPrev, plusNow, minusNow].some(v => v === null || v === undefined || Number.isNaN(v))) return null;

  const price = last.close;

  const atrPct = (atrNow / price) * 100;
  const volOk = atrPct >= cfg.minAtrPct;
  const notNearRound = !nearRoundNumber(price, cfg.roundStep, atrNow, cfg.roundBuffer);

  const trendBull = emaFNow > emaSNow && plusNow > minusNow;
  const trendBear = emaFNow < emaSNow && minusNow > plusNow;
  const adxOk = adxNow > cfg.adxMin;
  const adxRising = adxNow > adxPrev;

  const extension = Math.abs(price - emaFNow);
  const notExtended = extension <= atrNow * cfg.extMult;

  const fib = getFibLevels(closed, cfg.fibLookback);
  const fibBuy = matchedFibLevel(price, fib.buyLevels, atrNow, cfg.fibTolMult);
  const fibSell = matchedFibLevel(price, fib.sellLevels, atrNow, cfg.fibTolMult);

  const recent = closed.slice(-3);
  const touchedFromAbove = recent.some(c => c.low <= emaFNow + atrNow * cfg.pullbackTol);
  const touchedFromBelow = recent.some(c => c.high >= emaFNow - atrNow * cfg.pullbackTol);

  const bullPattern = bullishReversalPattern(prev, last) && price > emaFNow;
  const bearPattern = bearishReversalPattern(prev, last) && price < emaFNow;

  const baseOk = volOk && notNearRound && adxOk && adxRising && notExtended;

  if (baseOk && trendBull && touchedFromAbove && bullPattern && fibBuy) {
    return { direction: 'BUY', price, atrNow, closed, fibLevel: fibBuy };
  }
  if (baseOk && trendBear && touchedFromBelow && bearPattern && fibSell) {
    return { direction: 'SELL', price, atrNow, closed, fibLevel: fibSell };
  }
  return null;
}

// ─────────────────────────────────────────────
// SL / TP
// ─────────────────────────────────────────────

function computeLevels(direction, price, atrNow, closed, cfg) {
  const slDistAtr = atrNow * cfg.atrSlMult;
  const round2 = x => Math.round(x * 100) / 100;
  let sl, tp1, tp2, tp3, slDist;

  if (direction === 'BUY') {
    const slStruct = swingLow(closed, 10);
    sl = Math.min(slStruct - atrNow * 0.1, price - slDistAtr);
    slDist = price - sl;
    tp1 = price + slDist;
    tp2 = price + slDist * 2;
    tp3 = price + slDist * 3;
  } else {
    const slStruct = swingHigh(closed, 10);
    sl = Math.max(slStruct + atrNow * 0.1, price + slDistAtr);
    slDist = sl - price;
    tp1 = price - slDist;
    tp2 = price - slDist * 2;
    tp3 = price - slDist * 3;
  }

  return { sl: round2(sl), tp1: round2(tp1), tp2: round2(tp2), tp3: round2(tp3), slDist };
}

// ─────────────────────────────────────────────
// ANALYSE
// ─────────────────────────────────────────────

async function analyzeUS100() {
  const cfg = US100_CONFIG;
  if (minutesSinceSessionStart() < cfg.sessionWarmupMin) return null;

  const htf = await getHtfTrendCached(cfg.symbol);
  if (!htf) return null;

  const candles = await getCandles(cfg.symbol, '5min', 100);
  if (!candles || candles.length < 60) return null;

  const entry = detectPullbackEntry(candles, cfg);
  if (!entry) return null;
  if ((entry.direction === 'BUY' && htf !== 'BULL') || (entry.direction === 'SELL' && htf !== 'BEAR')) return null;

  const closes = entry.closed.map(c => c.close);
  const rsiArr = rsi(closes, cfg.rsiPeriod);
  const rsiNow = rsiArr[rsiArr.length - 1];
  if (entry.direction === 'BUY' && rsiNow > 70) return null;
  if (entry.direction === 'SELL' && rsiNow < 30) return null;

  const levels = computeLevels(entry.direction, entry.price, entry.atrNow, entry.closed, cfg);
  const candleTime = entry.closed[entry.closed.length - 1].time;

  return { direction: entry.direction, price: Math.round(entry.price * 100) / 100, ...levels, htf, candleTime, fibLevel: entry.fibLevel };
}

// ─────────────────────────────────────────────
// MESSAGE
// ─────────────────────────────────────────────

function positionSizingText(slDist, cfg) {
  if (ACCOUNT_BALANCE <= 0) return '';
  const riskAmount = ACCOUNT_BALANCE * RISK_PERCENT / 100;
  const lot = riskAmount / (slDist * cfg.pointValuePerLot);
  return `\n💰 Risque  : ${riskAmount.toFixed(2)}€ (${RISK_PERCENT}%)\n📦 Taille  : ~${lot.toFixed(2)} lot (a verifier selon ton broker)`;
}

function formatMessage(label, sig, cfg) {
  const now = new Date().toISOString().slice(11, 16) + ' UTC';
  const arrow = sig.direction === 'BUY' ? '🟢' : '🔴';
  const slD = Math.round(Math.abs(sig.price - sig.sl) * 100) / 100;

  let msg = `${arrow} ${sig.direction} SIGNAL - ${label}\n`;
  msg += '━━━━━━━━━━━━━━━━━━\n';
  msg += `🕐 Heure  : ${now}\n`;
  msg += `📍 Entry  : ${sig.price}\n`;
  msg += `🛑 SL     : ${sig.sl}  (-${slD})\n`;
  msg += '━━━━━━━━━━━━━━━━━━\n';
  msg += `🎯 TP1    : ${sig.tp1}  (RR 1:1)\n`;
  msg += `🎯 TP2    : ${sig.tp2}  (RR 1:2)\n`;
  msg += `🎯 TP3    : ${sig.tp3}  (RR 1:3)\n`;
  msg += '━━━━━━━━━━━━━━━━━━\n';
  msg += `📈 Tendance H1+H4 : ${sig.htf} ✅\n`;
  msg += `📐 Setup  : Pullback + bougie + Fibo ${sig.fibLevel}\n`;
  msg += positionSizingText(sig.slDist, cfg) + '\n';
  msg += '━━━━━━━━━━━━━━━━━━\n';
  msg += `📋 Gestion : TP1 -> sécurise 50% + SL a BE | TP2 -> trailing stop\n`;
  msg += `⚠️ Signal indicatif - vérifiez sur MT5 (symbole USTEC pour FTMO)`;
  return msg;
}

// ─────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────

let lastSignal = null;
let tradeCount = { date: null, count: 0 };

function canTradeToday() {
  const today = new Date().toISOString().slice(0, 10);
  if (tradeCount.date !== today) { tradeCount.date = today; tradeCount.count = 0; }
  return tradeCount.count < MAX_TRADES_PER_DAY;
}

async function run() {
  try {
    if (!isMarketOpen()) return;
    if (!canTradeToday()) return;

    const sig = await analyzeUS100();
    if (!sig) return;

    const key = sig.direction + '_' + sig.candleTime;
    if (lastSignal === key) return;

    await sendTelegram(formatMessage('US100', sig, US100_CONFIG));
    lastSignal = key;
    tradeCount.count++;
    console.log('Signal US100:', sig.direction, sig.price, sig.candleTime);
  } catch (e) {
    console.error('Erreur scan:', e.message);
  }
}

sendTelegram(`🤖 US100 Signal Bot v4 démarré (Node.js)\nFiltres pro scalping actifs : pattern de retournement, Fibo, volatilité min, niveaux ronds, anti-ouverture, max ${MAX_TRADES_PER_DAY} trades/jour ✅\nSymbole d'exécution : USTEC (FTMO)`);
run();
setInterval(run, SCAN_INTERVAL * 1000);
