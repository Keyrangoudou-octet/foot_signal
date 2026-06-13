# US100 Signal Bot v4 - Railway / Twelve Data
# US100 (Nasdaq 100) - M5 - Sessions Londres + New York
# Pullback + bougie de retournement + H1/H4 + ADX croissant + filtres scalping pro

import asyncio
import logging
import os
import requests
import pandas as pd
from datetime import datetime, timezone
from telegram import Bot

TELEGRAM_TOKEN   = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
TWELVE_API_KEY   = os.environ["TWELVE_API_KEY"]

SCAN_INTERVAL = 60
HTF_CACHE_TTL = 900

ACCOUNT_BALANCE    = float(os.environ.get("ACCOUNT_BALANCE", "0"))   # 0 = désactivé
RISK_PERCENT       = float(os.environ.get("RISK_PERCENT", "1.0"))
MAX_TRADES_PER_DAY = int(os.environ.get("MAX_TRADES_PER_DAY", "5"))

SESSION_LONDON_START  = 8
SESSION_LONDON_END    = 17
SESSION_NY_START      = 13
SESSION_NY_END        = 22

US100_CONFIG = {
    "symbol"       : "NDX",
    "label"        : "US100",
    "ema_fast"     : 20,
    "ema_slow"     : 50,
    "rsi_period"   : 14,
    "atr_period"   : 14,
    "adx_period"   : 14,
    "adx_min"      : 18,
    "atr_sl_mult"  : 1.5,
    "ext_mult"     : 1.2,
    "pullback_tol" : 0.5,
    "min_atr_pct"  : 0.05,
    "round_step"   : 100,
    "round_buffer" : 0.15,
    "session_warmup_min": 10,
    "point_value_per_lot": 1,  # a verifier selon specs FTMO pour USTEC
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger(__name__)

def is_market_open():
    now_utc = datetime.now(timezone.utc)
    if now_utc.weekday() >= 5:
        return False
    hour = now_utc.hour
    in_london = SESSION_LONDON_START <= hour < SESSION_LONDON_END
    in_ny     = SESSION_NY_START     <= hour < SESSION_NY_END
    return in_london or in_ny

def minutes_since_session_start():
    now = datetime.now(timezone.utc)
    elapsed_london = (now.hour - SESSION_LONDON_START) * 60 + now.minute
    elapsed_ny     = (now.hour - SESSION_NY_START) * 60 + now.minute
    candidates = [e for e in [elapsed_london, elapsed_ny] if e >= 0]
    if not candidates:
        return 9999
    return min(candidates)

def get_candles(symbol, interval="5min", outputsize=100):
    try:
        url = "https://api.twelvedata.com/time_series"
        params = {
            "symbol"    : symbol,
            "interval"  : interval,
            "outputsize": outputsize,
            "apikey"    : TWELVE_API_KEY,
            "format"    : "JSON"
        }
        r = requests.get(url, params=params, timeout=10)
        data = r.json()
        if "values" not in data:
            log.error("Twelve Data erreur " + symbol + " [" + interval + "]: " + str(data.get("message", "unknown")))
            return None
        df = pd.DataFrame(data["values"])
        df = df.rename(columns={"datetime": "time"})
        for col in ["open", "high", "low", "close"]:
            df[col] = pd.to_numeric(df[col])
        df = df.iloc[::-1].reset_index(drop=True)
        return df
    except Exception as e:
        log.error("get_candles " + symbol + " [" + interval + "]: " + str(e))
        return None

def ema(series, period):
    return series.ewm(span=period, adjust=False).mean()

def rsi(series, period=14):
    delta = series.diff()
    gain  = delta.clip(lower=0).rolling(period).mean()
    loss  = (-delta.clip(upper=0)).rolling(period).mean()
    rs    = gain / loss
    return 100 - (100 / (1 + rs))

def adx(df, period=14):
    high  = df["high"]
    low   = df["low"]
    close = df["close"]
    plus_dm  = high.diff().clip(lower=0)
    minus_dm = (-low.diff()).clip(lower=0)
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low  - close.shift()).abs()
    ], axis=1).max(axis=1)
    atr_raw  = tr.rolling(period).mean()
    plus_di  = 100 * (plus_dm.rolling(period).mean() / atr_raw)
    minus_di = 100 * (minus_dm.rolling(period).mean() / atr_raw)
    denom    = (plus_di + minus_di).replace(0, pd.NA)
    dx       = 100 * (plus_di - minus_di).abs() / denom
    return dx.rolling(period).mean().fillna(0), plus_di, minus_di

def atr(df, period=14):
    high  = df["high"]
    low   = df["low"]
    close = df["close"]
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low  - close.shift()).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()

def swing_low(df, n=10):
    return float(df["low"].iloc[-n-1:-1].min())

def swing_high(df, n=10):
    return float(df["high"].iloc[-n-1:-1].max())

def bullish_reversal_pattern(prev, curr):
    body_curr = abs(curr["close"] - curr["open"])
    lower_wick = min(curr["close"], curr["open"]) - curr["low"]
    upper_wick = curr["high"] - max(curr["close"], curr["open"])

    bullish_engulfing = (curr["close"] > curr["open"] and prev["close"] < prev["open"]
                          and curr["close"] >= prev["open"] and curr["open"] <= prev["close"])
    hammer = (curr["close"] > curr["open"] and body_curr > 0
              and lower_wick >= body_curr * 1.5 and upper_wick <= body_curr * 0.5)
    return bullish_engulfing or hammer

def bearish_reversal_pattern(prev, curr):
    body_curr = abs(curr["close"] - curr["open"])
    lower_wick = min(curr["close"], curr["open"]) - curr["low"]
    upper_wick = curr["high"] - max(curr["close"], curr["open"])

    bearish_engulfing = (curr["close"] < curr["open"] and prev["close"] > prev["open"]
                          and curr["close"] <= prev["open"] and curr["open"] >= prev["close"])
    shooting_star = (curr["close"] < curr["open"] and body_curr > 0
                      and upper_wick >= body_curr * 1.5 and lower_wick <= body_curr * 0.5)
    return bearish_engulfing or shooting_star

def near_round_number(price, step, atr_now, buffer_mult):
    nearest = round(price / step) * step
    return abs(price - nearest) <= atr_now * buffer_mult

htf_cache = {}

def get_htf_trend(symbol):
    df_h1 = get_candles(symbol, interval="1h", outputsize=60)
    df_h4 = get_candles(symbol, interval="4h", outputsize=60)
    if df_h1 is None or len(df_h1) < 55 or df_h4 is None or len(df_h4) < 55:
        return None

    f1 = float(ema(df_h1["close"], 15).iloc[-1])
    s1 = float(ema(df_h1["close"], 50).iloc[-1])
    f4 = float(ema(df_h4["close"], 15).iloc[-1])
    s4 = float(ema(df_h4["close"], 50).iloc[-1])

    h1_dir = "BULL" if f1 > s1 else "BEAR"
    h4_dir = "BULL" if f4 > s4 else "BEAR"

    if h1_dir == h4_dir:
        return h1_dir
    return None

def get_htf_trend_cached(symbol):
    now = datetime.now(timezone.utc).timestamp()
    cached = htf_cache.get(symbol)
    if cached and (now - cached[0]) < HTF_CACHE_TTL:
        return cached[1]
    trend = get_htf_trend(symbol)
    htf_cache[symbol] = (now, trend)
    return trend

def detect_pullback_entry(df, cfg):
    closed = df.iloc[:-1]
    if len(closed) < max(cfg["ema_slow"], cfg["adx_period"]) + 10:
        return None, None, None, None

    ema_f = ema(closed["close"], cfg["ema_fast"])
    ema_s = ema(closed["close"], cfg["ema_slow"])
    atr_s = atr(closed, cfg["atr_period"])
    adx_s, plus_di, minus_di = adx(closed, cfg["adx_period"])

    last = closed.iloc[-1]
    prev = closed.iloc[-2]
    ema_f_now = float(ema_f.iloc[-1])
    ema_s_now = float(ema_s.iloc[-1])
    atr_now   = float(atr_s.iloc[-1])
    adx_now   = float(adx_s.iloc[-1])
    adx_prev  = float(adx_s.iloc[-4])
    plus_now  = float(plus_di.iloc[-1])
    minus_now = float(minus_di.iloc[-1])

    price = float(last["close"])

    atr_pct = (atr_now / price) * 100
    vol_ok = atr_pct >= cfg["min_atr_pct"]

    not_near_round = not near_round_number(price, cfg["round_step"], atr_now, cfg["round_buffer"])

    trend_bull = ema_f_now > ema_s_now and plus_now > minus_now
    trend_bear = ema_f_now < ema_s_now and minus_now > plus_now
    adx_ok     = adx_now > cfg["adx_min"]
    adx_rising = adx_now > adx_prev

    extension    = abs(price - ema_f_now)
    not_extended = extension <= atr_now * cfg["ext_mult"]

    recent = closed.iloc[-3:]
    touched_from_above = (recent["low"]  <= ema_f_now + atr_now * cfg["pullback_tol"]).any()
    touched_from_below = (recent["high"] >= ema_f_now - atr_now * cfg["pullback_tol"]).any()

    bull_pattern = bullish_reversal_pattern(prev, last) and price > ema_f_now
    bear_pattern = bearish_reversal_pattern(prev, last) and price < ema_f_now

    base_ok = vol_ok and not_near_round and adx_ok and adx_rising and not_extended

    if base_ok and trend_bull and touched_from_above and bull_pattern:
        return "BUY", price, atr_now, closed
    if base_ok and trend_bear and touched_from_below and bear_pattern:
        return "SELL", price, atr_now, closed

    return None, None, None, None

def compute_levels(direction, price, atr_now, closed, cfg):
    sl_dist_atr = atr_now * cfg["atr_sl_mult"]
    if direction == "BUY":
        sl_struct = swing_low(closed, n=10)
        sl = min(sl_struct - atr_now * 0.1, price - sl_dist_atr)
        sl_dist = price - sl
        tp1 = price + sl_dist
        tp2 = price + sl_dist * 2
        tp3 = price + sl_dist * 3
    else:
        sl_struct = swing_high(closed, n=10)
        sl = max(sl_struct + atr_now * 0.1, price + sl_dist_atr)
        sl_dist = sl - price
        tp1 = price - sl_dist
        tp2 = price - sl_dist * 2
        tp3 = price - sl_dist * 3
    return round(sl, 2), round(tp1, 2), round(tp2, 2), round(tp3, 2), sl_dist

def analyze_us100():
    cfg = US100_CONFIG
    if minutes_since_session_start() < cfg["session_warmup_min"]:
        return None

    htf = get_htf_trend_cached(cfg["symbol"])
    if htf is None:
        return None

    df = get_candles(cfg["symbol"], outputsize=100)
    if df is None or len(df) < 60:
        return None

    direction, price, atr_now, closed = detect_pullback_entry(df, cfg)
    if direction is None:
        return None
    if (direction == "BUY" and htf != "BULL") or (direction == "SELL" and htf != "BEAR"):
        return None

    rsi_now = float(rsi(closed["close"], cfg["rsi_period"]).iloc[-1])
    if direction == "BUY" and rsi_now > 70:
        return None
    if direction == "SELL" and rsi_now < 30:
        return None

    sl, tp1, tp2, tp3, sl_dist = compute_levels(direction, price, atr_now, closed, cfg)
    candle_time = str(closed["time"].iloc[-1])
    return (direction, round(price, 2), sl, tp1, tp2, tp3, sl_dist, htf, candle_time)

def position_sizing_text(sl_dist, cfg):
    if ACCOUNT_BALANCE <= 0:
        return ""
    risk_amount = ACCOUNT_BALANCE * RISK_PERCENT / 100
    lot = risk_amount / (sl_dist * cfg["point_value_per_lot"])
    return ("\n💰 Risque  : " + str(round(risk_amount, 2)) + "€ (" + str(RISK_PERCENT) + "%)\n"
            "📦 Taille  : ~" + str(round(lot, 2)) + " lot (a verifier selon ton broker)")

def format_message(label, direction, price, sl, tp1, tp2, tp3, sl_dist, htf, cfg):
    now = datetime.utcnow().strftime("%H:%M UTC")
    arrow = "🟢" if direction == "BUY" else "🔴"
    sl_d = round(abs(price - sl), 2)

    msg  = arrow + " " + direction + " SIGNAL - " + label + "\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "🕐 Heure  : " + now + "\n"
    msg += "📍 Entry  : " + str(price) + "\n"
    msg += "🛑 SL     : " + str(sl) + "  (-" + str(sl_d) + ")\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "🎯 TP1    : " + str(tp1) + "  (RR 1:1)\n"
    msg += "🎯 TP2    : " + str(tp2) + "  (RR 1:2)\n"
    msg += "🎯 TP3    : " + str(tp3) + "  (RR 1:3)\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "📈 Tendance H1+H4 : " + htf + " ✅\n"
    msg += "📐 Setup  : Pullback + bougie de retournement\n"
    msg += position_sizing_text(sl_dist, cfg) + "\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "📋 Gestion : TP1 -> sécurise 50% + SL a BE | TP2 -> trailing stop\n"
    msg += "⚠️ Signal indicatif - vérifiez sur MT5 (symbole USTEC pour FTMO)"
    return msg

last_signal = None
trade_count = {"date": None, "count": 0}

def can_trade_today():
    today = datetime.now(timezone.utc).date()
    if trade_count["date"] != today:
        trade_count["date"] = today
        trade_count["count"] = 0
    return trade_count["count"] < MAX_TRADES_PER_DAY

def register_trade():
    trade_count["count"] += 1

async def main():
    global last_signal
    bot = Bot(token=TELEGRAM_TOKEN)
    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text="🤖 US100 Signal Bot v4 démarré\nFiltres pro scalping actifs : pattern de retournement, volatilité min, niveaux ronds, anti-ouverture, max " + str(MAX_TRADES_PER_DAY) + " trades/jour ✅\nSymbole d'exécution : USTEC (FTMO)"
    )
    log.info("Bot démarré v4 - US100")

    while True:
        try:
            if not is_market_open():
                log.info("Marché fermé - attente")
                await asyncio.sleep(SCAN_INTERVAL)
                continue

            if can_trade_today():
                us = analyze_us100()
                if us:
                    direction, price, sl, tp1, tp2, tp3, sl_dist, htf, candle_time = us
                    key = direction + "_" + candle_time
                    if last_signal != key:
                        msg = format_message("US100", direction, price, sl, tp1, tp2, tp3, sl_dist, htf, US100_CONFIG)
                        await bot.send_message(chat_id=TELEGRAM_CHAT_ID, text=msg)
                        last_signal = key
                        register_trade()
                        log.info("Signal US100: " + direction + " @ " + str(price) + " | bougie " + candle_time)

        except Exception as e:
            log.error("Erreur scan: " + str(e))

        await asyncio.sleep(SCAN_INTERVAL)

if __name__ == "__main__":
    asyncio.run(main())
