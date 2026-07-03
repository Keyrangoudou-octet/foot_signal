import time
import requests
from bs4 import BeautifulSoup
from loguru import logger

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"}
SOURCE_NAME = "PredictZ"
BASE_URL = "https://www.predictz.com/predictions/"

TIP_MAP = {"1": "1", "home": "1", "home win": "1", "x": "X", "draw": "X", "2": "2", "away": "2", "away win": "2"}

def _map_tip(raw):
    return TIP_MAP.get(raw.strip().lower())

def scrape():
    predictions = []
    try:
        time.sleep(1.5)
        r = requests.get(BASE_URL, headers=HEADERS, timeout=20)
        r.raise_for_status()
    except Exception as e:
        logger.error(f"[{SOURCE_NAME}] Erreur: {e}")
        return predictions

    soup = BeautifulSoup(r.text, "lxml")
    rows = soup.select("table.ptab tbody tr") or soup.select("div.pitem")
    current_competition = ""

    for row in rows:
        header = row.find("th")
        if header:
            current_competition = header.get_text(strip=True)
            continue
        try:
            cells = row.find_all("td")
            if len(cells) < 3: continue
            home, away, match_time, tip_raw, probability = "", "", "", "", 0.0
            for cell in cells:
                cls = " ".join(cell.get("class", []))
                txt = cell.get_text(strip=True)
                if "time" in cls: match_time = txt
                elif "home" in cls: home = txt
                elif "away" in cls: away = txt
                elif "tip" in cls or "pick" in cls: tip_raw = txt
                elif "%" in txt:
                    try: probability = float(txt.replace("%", ""))
                    except: pass
            if not home and len(cells) >= 4:
                texts = [c.get_text(strip=True) for c in cells]
                match_time, home, away, tip_raw = texts[0], texts[1], texts[2], texts[3]
                if len(texts) > 4 and "%" in texts[4]:
                    try: probability = float(texts[4].replace("%", ""))
                    except: pass
            if not home or not away: continue
            outcome = _map_tip(tip_raw)
            if outcome:
                predictions.append({"source": SOURCE_NAME, "home_team": home, "away_team": away, "outcome": outcome, "probability": probability, "competition": current_competition, "match_time": match_time})
        except: continue

    logger.info(f"[{SOURCE_NAME}] {len(predictions)} prédictions")
    return predictions
