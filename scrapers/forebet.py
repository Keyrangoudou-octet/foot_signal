import time
import requests
from bs4 import BeautifulSoup
from loguru import logger

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
}

SOURCE_NAME = "Forebet"
BASE_URL = "https://www.forebet.com/en/predictions/predictions-1"

def _outcome_from_scores(s1, s2):
    try:
        s1, s2 = int(s1.strip()), int(s2.strip())
        return "1" if s1 > s2 else ("X" if s1 == s2 else "2")
    except: return None

def scrape():
    predictions = []
    try:
        logger.info(f"[{SOURCE_NAME}] Scraping...")
        time.sleep(1)
        r = requests.get(BASE_URL, headers=HEADERS, timeout=20)
        r.raise_for_status()
    except Exception as e:
        logger.error(f"[{SOURCE_NAME}] Erreur: {e}")
        return predictions

    soup = BeautifulSoup(r.text, "lxml")
    rows = soup.select("table.schema tr.tr_0, table.schema tr.tr_1")
    if not rows:
        rows = soup.select("div.rcnt")

    for row in rows:
        try:
            cells = row.find_all("td")
            if len(cells) < 6: continue
            time_cell = cells[0].get_text(strip=True)
            teams_cell = cells[1]
            links = teams_cell.find_all("a")
            if len(links) >= 2:
                home, away = links[0].get_text(strip=True), links[1].get_text(strip=True)
            else:
                parts = teams_cell.get_text(" ", strip=True).split("-")
                if len(parts) < 2: continue
                home, away = parts[0].strip(), parts[1].strip()
            if not home or not away: continue
            outcome, probability = None, 0.0
            for cell in cells:
                txt = cell.get_text(strip=True)
                if "-" in txt and len(txt) <= 5:
                    p = txt.split("-")
                    if len(p) == 2 and all(x.isdigit() for x in p):
                        outcome = _outcome_from_scores(p[0], p[1])
                if "%" in txt:
                    try: probability = float(txt.replace("%", "").strip())
                    except: pass
            if outcome is None:
                for cell in cells:
                    if cell.get_text(strip=True) in ("1", "X", "2"):
                        outcome = cell.get_text(strip=True); break
            if outcome:
                predictions.append({"source": SOURCE_NAME, "home_team": home, "away_team": away, "outcome": outcome, "probability": probability, "competition": "", "match_time": time_cell})
        except: continue

    logger.info(f"[{SOURCE_NAME}] {len(predictions)} prédictions")
    return predictions
