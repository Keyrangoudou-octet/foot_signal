const https = require("https");

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_KEY = process.env.TWELVE_DATA_KEY || "f7bdc6c27e9f4cec9effabb7b8664893";

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, res => { res.on("data", () => {}); res.on("end", resolve); });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

function sendTelegram(msg) {
  return post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID, text: msg, parse_mode: "Markdown"
  });
}

function getSession() {
  const now = new Date();
  const t = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (t >= 12*60 && t < 13*60+30)  return "Pre-Market 🔔";
  if (t >= 13*60+30 && t < 16*60)  return "NY Open 🇺🇸🔥";
  if (t >= 18*60 && t < 20*60)     return "NY Afternoon 🇺🇸";
  return null;
}

function isWeekend() {
  const d = new Date().getUTCDay();
  return d === 0 || d === 6;
}

function calcATR(candles, p = 14) {
  let atr = 0;
  for (let i = 1; i <= p; i++) {
    atr += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    );
  }
  atr /= p;
  for (let i = p+1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    );
    atr = (atr * (p-1) + tr) / p;
  }
  return atr;
}

function calcEMA(vals, p) {
  const k = 2 / (p+1);
  let ema = vals.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i = p; i < vals.length; i++) ema = vals[i]*k + ema*(1-k);
  return ema;
}

function getSwings(candles, lookback = 5) {
  const swingHighs = [], swingLows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const maxH  = Math.max(...slice.map(c => c.high));
    const minL  = Math.min(...slice.map(c => c.low));
    if (candles[i].high === maxH) swingHighs.push({ i, price: candles[i].high });
    if (candles[i].low  === minL) swingLows.push({  i, price: candles[i].low  });
  }
  return { swingHighs, swingLows };
}

function detectCHoCH(candles, swings) {
  const last = candles[candles.length - 1];
  const recentHighs = swings.swingHighs.slice(-5);
  const recentLows  = swings.swingLows.slice(-5);

  if (recentHighs.length >= 2) {
    const lastHigh = recentHighs[recentHighs.length - 1];
    const prevHigh = recentHighs[recentHighs.length - 2];
    if (prevHigh.price > lastHigh.price && last.close > lastHigh.price)
      return { type: "BULLISH_CHOCH", level: lastHigh.price };
  }
  if (recentLows.length >= 2) {
    const lastLow = recentLows[recentLows.length - 1];
    const prevLow = recentLows[recentLows.length - 2];
    if (prevLow.price < lastLow.price && last.close < lastLow.price)
      return { type: "BEARISH_CHOCH", level: lastLow.price };
  }
  return null;
}

function detectLiqSweep(candles, swings) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const recentHighs = swings.swingHighs.slice(-4).map(s => s.price);
  const recentLows  = swings.swingLows.slice(-4).map(s => s.price);

  for (const low of recentLows) {
    if (prev.low < low && prev.close > low && last.close > low)
      return { type: "BULLISH_SWEEP", sweptLevel: low };
    if (last.low < low && last.close > low)
      return { type: "BULLISH_SWEEP", sweptLevel: low };
  }
  for (const high of recentHighs) {
    if (prev.high > high && prev.close < high && last.close < high)
      return { type: "BEARISH_SWEEP", sweptLevel: high };
    if (last.high > high && last.close < high)
      return { type: "BEARISH_SWEEP", sweptLevel: high };
  }
  return null;
}

function detectBOS(candles, swings) {
  const last = candles[candles.length - 1];
  const recentHighs = swings.swingHighs.slice(-3).map(s => s.price);
  const recentLows  = swings.swingLows.slice(-3).map(s => s.price);
  for (const high of recentHighs) if (last.close > high) return { type: "BULLISH_BOS", level: high };
  for (const low  of recentLows)  if (last.close < low)  return { type: "BEARISH_BOS", level: low };
  return null;
}

function detectSupplyDemand(candles, atr) {
  const zones = [];
  for (let i = 3; i < candles.length - 1; i++) {
    const body = Math.abs(candles[i].close - candles[i].open);
    if (body > atr * 1.5) {
      if (candles[i].close > candles[i].open)
        zones.push({ type: "DEMAND", top: candles[i].open, bottom: candles[i].low, i });
      else
        zones.push({ type: "SUPPLY", top: candles[i].high, bottom: candles[i].open, i });
    }
  }
  return zones.slice(-6);
}

function calcFibonacci(swings) {
  const swingHigh = swings.swingHighs.slice(-1)[0];
  const swingLow  = swings.swingLows.slice(-1)[0];
  if (!swingHigh || !swingLow) return null;
  const range = swingHigh.price - swingLow.price;
  return {
    swingHigh: swingHigh.price, swingLow: swingLow.price,
    f236: parseFloat((swingHigh.price - range * 0.236).toFixed(2)),
    f382: parseFloat((swingHigh.price - range * 0.382).toFixed(2)),
    f500: parseFloat((swingHigh.price - range * 0.5).toFixed(2)),
    f618: parseFloat((swingHigh.price - range * 0.618).toFixed(2)),
    f706: parseFloat((swingHigh.price - range * 0.706).toFixed(2)),
    f786: parseFloat((swingHigh.price - range * 0.786).toFixed(2)),
    f618up: parseFloat((swingLow.price + range * 0.618).toFixed(2)),
    f706up: parseFloat((swingLow.price + range * 0.706).toFixed(2)),
    f786up: parseFloat((swingLow.price + range * 0.786).toFixed(2)),
  };
}

function inGoldenZone(price, fib, direction) {
  if (!fib) return false;
  if (direction === "BUY")  return price >= fib.f786 && price <= fib.f618;
  if (direction === "SELL") return price >= fib.f618up && price <= fib.f786up;
  return false;
}

function analyzeSMC(candles) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const atr    = calcATR(candles);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);

  const swings = getSwings(candles, 5);
  const choch  = detectCHoCH(candles, swings);
  const sweep  = detectLiqSweep(candles, swings);
  const bos    = detectBOS(candles, swings);
  const zones  = detectSupplyDemand(candles, atr);
  const fib    = calcFibonacci(swings);

  const htfBull    = ema50 > ema200;
  const nearDemand = zones.find(z => z.type === "DEMAND" && price >= z.bottom && price <= z.top + atr);
  const nearSupply = zones.find(z => z.type === "SUPPLY" && price <= z.top && price >= z.bottom - atr);
  const inGoldenBuy  = inGoldenZone(price, fib, "BUY");
  const inGoldenSell = inGoldenZone(price, fib, "SELL");

  let buyConf = 0, buyReasons = [];
  if (choch?.type === "BULLISH_CHOCH") { buyConf++; buyReasons.push(`✅ CHoCH haussier à ${choch.level.toFixed(0)}`); }
  if (sweep?.type === "BULLISH_SWEEP") { buyConf++; buyReasons.push(`✅ Liquidity Sweep haussier à ${sweep.sweptLevel.toFixed(0)}`); }
  if (bos?.type   === "BULLISH_BOS")   { buyConf++; buyReasons.push(`✅ BOS haussier à ${bos.level.toFixed(0)}`); }
  if (inGoldenBuy && fib)              { buyConf++; buyReasons.push(`✅ Golden Zone Fibo (${fib.f786.toFixed(0)}-${fib.f618.toFixed(0)})`); }
  if (nearDemand)                      { buyConf++; buyReasons.push(`✅ Demand Zone (${nearDemand.bottom.toFixed(0)}-${nearDemand.top.toFixed(0)})`); }
  if (htfBull)                         { buyConf++; buyReasons.push(`✅ Trend HTF haussier (EMA50 > EMA200)`); }

  let sellConf = 0, sellReasons = [];
  if (choch?.type === "BEARISH_CHOCH") { sellConf++; sellReasons.push(`✅ CHoCH baissier à ${choch.level.toFixed(0)}`); }
  if (sweep?.type === "BEARISH_SWEEP") { sellConf++; sellReasons.push(`✅ Liquidity Sweep baissier à ${sweep.sweptLevel.toFixed(0)}`); }
  if (bos?.type   === "BEARISH_BOS")   { sellConf++; sellReasons.push(`✅ BOS baissier à ${bos.level.toFixed(0)}`); }
  if (inGoldenSell && fib)             { sellConf++; sellReasons.push(`✅ Golden Zone Fibo (${fib.f618up.toFixed(0)}-${fib.f786up.toFixed(0)})`); }
  if (nearSupply)                      { sellConf++; sellReasons.push(`✅ Supply Zone (${nearSupply.bottom.toFixed(0)}-${nearSupply.top.toFixed(0)})`); }
  if (!htfBull)                        { sellConf++; sellReasons.push(`✅ Trend HTF baissier (EMA50 < EMA200)`); }

  const buyValid  = sweep?.type === "BULLISH_SWEEP" && bos?.type === "BULLISH_BOS" && buyConf >= 3;
  const sellValid = sweep?.type === "BEARISH_SWEEP" && bos?.type === "BEARISH_BOS" && sellConf >= 3;

  let signal, reasons, conf;
  if      (buyValid)  { signal = "BUY";  reasons = buyReasons;  conf = buyConf; }
  else if (sellValid) { signal = "SELL"; reasons = sellReasons; conf = sellConf; }
  else return null;

  let sl, tp1, tp2;
  if (signal === "BUY") {
    sl  = parseFloat((sweep.sweptLevel - atr * 0.3).toFixed(1));
    const nextHigh = swings.swingHighs.slice(-1)[0];
    tp1 = nextHigh ? parseFloat(nextHigh.price.toFixed(1)) : parseFloat((price + atr * 2).toFixed(1));
    tp2 = fib      ? parseFloat(fib.swingHigh.toFixed(1))  : parseFloat((price + atr * 4).toFixed(1));
  } else {
    sl  = parseFloat((sweep.sweptLevel + atr * 0.3).toFixed(1));
    const nextLow = swings.swingLows.slice(-1)[0];
    tp1 = nextLow ? parseFloat(nextLow.price.toFixed(1)) : parseFloat((price - atr * 2).toFixed(1));
    tp2 = fib     ? parseFloat(fib.swingLow.toFixed(1))  : parseFloat((price - atr * 4).toFixed(1));
  }

  const slPts  = parseFloat(Math.abs(price - sl).toFixed(1));
  const tp1Pts = parseFloat(Math.abs(tp1 - price).toFixed(1));
  const tp2Pts = parseFloat(Math.abs(tp2 - price).toFixed(1));
  const rr1    = parseFloat((tp1Pts / slPts).toFixed(1));
  const rr2    = parseFloat((tp2Pts / slPts).toFixed(1));

  return { signal, price, sl, tp1, tp2, slPts, tp1Pts, tp2Pts, rr1, rr2, reasons, conf, fib, atr, ema50, ema200 };
}

async function fetchNAS100Candles() {
  const url = `https://api.twelvedata.com/time_series?symbol=NDX&interval=5min&outputsize=150&apikey=${API_KEY}`;
  const data = await get(url);
  if (data.status === "error") throw new Error("Twelve Data: " + data.message);
  if (!data.values || data.values.length === 0) throw new Error("Pas de données NAS100");
  return data.values.reverse().map(c => ({
    open: parseFloat(c.open), high: parseFloat(c.high),
    low:  parseFloat(c.low),  close: parseFloat(c.close), vol: 0,
  }));
}

let lastSignalTime = 0;
const COOLDOWN = 45 * 60 * 1000;

async function run() {
  if (isWeekend()) { console.log("Weekend — marchés fermés."); return; }
  const session = getSession();
  if (!session) { console.log(`${new Date().toISOString()} | Hors session NAS100.`); return; }

  try {
    const candles = await fetchNAS100Candles();
    const result  = analyzeSMC(candles);
    const price   = candles[candles.length - 1].close;

    if (!result) {
      console.log(`${new Date().toISOString()} | ${session} | NAS100 ${price.toFixed(1)} | Pas de setup SMC.`);
      return;
    }

    const now = Date.now();
    if (now - lastSignalTime < COOLDOWN) { console.log("Cooldown actif."); return; }
    lastSignalTime = now;

    const emoji  = result.signal === "BUY" ? "🟢" : "🔴";
    const action = result.signal === "BUY" ? "ACHÈTE" : "VENDS";

    const msg =
      `${emoji} *SIGNAL NAS100 — ${action}*\n` +
      `📍 Session : ${session}\n\n` +
      `💰 Entrée : *${result.price.toFixed(1)}*\n` +
      `🛑 SL : *${result.slPts.toFixed(1)} pts* (${result.sl.toFixed(1)})\n` +
      `🎯 TP1 : *${result.tp1Pts.toFixed(1)} pts* (${result.tp1.toFixed(1)}) — R/R 1:${result.rr1}\n` +
      `🎯 TP2 : *${result.tp2Pts.toFixed(1)} pts* (${result.tp2.toFixed(1)}) — R/R 1:${result.rr2}\n\n` +
      `*Confluences (${result.conf}/6) :*\n` +
      result.reasons.join("\n") + "\n\n" +
      (result.fib ?
        `*Niveaux Fibo :*\n` +
        `0.382 → ${result.fib.f382}\n` +
        `0.500 → ${result.fib.f500}\n` +
        `0.618 → *${result.fib.f618}* ⭐\n` +
        `0.706 → *${result.fib.f706}* ⭐\n` +
        `0.786 → ${result.fib.f786}\n\n` : "") +
      `📉 ATR : ${result.atr.toFixed(1)} pts | EMA50 : ${result.ema50.toFixed(1)} | EMA200 : ${result.ema200.toFixed(1)}\n\n` +
      `_Not financial advice._`;

    await sendTelegram(msg);
    console.log(`✅ Signal NAS100 : ${action} | ${result.price.toFixed(1)}`);

  } catch(e) { console.error("Erreur :", e.message); }
}

console.log("NAS100 SMC Bot démarré ✅");
sendTelegram(
  "📊 *NAS100 SMC Signal Bot démarré*\n\n" +
  "Stratégie : Smart Money Concepts\n" +
  "Logique : CHoCH + Liq Sweep + BOS + Golden Zone Fibo\n" +
  "Sessions : Pre-Market + NY Open + NY Afternoon\n" +
  "Actif : NAS100 (NDX) M5\n\n" +
  "Signaux envoyés uniquement pendant les Kill Zones 🎯"
);

run();
setInterval(run, 60 * 1000);
