import time
import requests
from bs4 import BeautifulSoup
from loguru import logger

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.predictz.com/",
}

SOURCE_NAME = "PredictZ"
BASE_URL = "https://www.predictz.com/predictions/"

TIP_MAP = {
    "1": "1", "home": "1", "home win": "1",
    "x": "X", "draw": "X",
    "2": "2", "away": "2", "away win": "2",
    "1x": "1", "x2": "2", "12": "1",
}

def _map_tip(raw_tip):
    return TIP_MAP.get(raw_tip.strip().lower())

def scrape():
    predictions = []
    try:
        logger.info(f"[{SOURCE_NAME}] Scraping — {BASE_URL}")
        time.sleep(1.5)
        response = requests.get(BASE_URL, headers=HEADERS, timeout=20)
        response.raise_for_status()
    except requests.RequestException as exc:
        logger.error(f"[{SOURCE_NAME}] Erreur réseau : {exc}")
        return predictions

    soup = BeautifulSoup(response.text, "lxml")
    rows = soup.select("table.ptab tbody tr")
    if not rows:
        rows = soup.select("div.pitem")
    logger.info(f"[{SOURCE_NAME}] {len(rows)} lignes trouvées")

    current_competition = ""
    for row in rows:
        header = row.find("th") or row.find("td", class_=lambda c: c and "league" in (c or "").lower())
        if header and not row.find_all("td", class_=lambda c: c and "team" in (c or "").lower()):
            current_competition = header.get_text(strip=True)
            continue
        try:
            pred = _parse_row(row, current_competition)
            if pred:
                predictions.append(pred)
        except Exception as exc:
            logger.debug(f"[{SOURCE_NAME}] Ignoré : {exc}")

    logger.info(f"[{SOURCE_NAME}] {len(predictions)} prédictions extraites")
    return predictions

def _parse_row(row, competition):
    cells = row.find_all("td")
    if len(cells) < 3:
        return None

    home_team = ""
    away_team = ""
    match_time = ""
    tip_raw = ""
    probability = 0.0

    for cell in cells:
        cls = " ".join(cell.get("class", []))
        if "time" in cls or "hour" in cls:
            match_time = cell.get_text(strip=True)
        elif "home" in cls:
            home_team = cell.get_text(strip=True)
        elif "away" in cls:
            away_team = cell.get_text(strip=True)
        elif "tip" in cls or "pick" in cls or "pred" in cls:
            tip_raw = cell.get_text(strip=True)
        elif "%" in cell.get_text():
            pct = cell.get_text(strip=True).replace("%", "").strip()
            try:
                probability = float(pct)
            except ValueError:
                pass

    if not home_team and len(cells) >= 4:
        texts = [c.get_text(strip=True) for c in cells]
        match_time, home_team, away_team, tip_raw = texts[0], texts[1], texts[2], texts[3]
        if len(texts) > 4 and "%" in texts[4]:
            try:
                probability = float(texts[4].replace("%", ""))
            except ValueError:
                pass

    if not home_team or not away_team:
        return None

    outcome = _map_tip(tip_raw)
    if not outcome:
        return None

    return {
        "source": SOURCE_NAME,
        "home_team": home_team,
        "away_team": away_team,
        "outcome": outcome,
        "probability": probability,
        "competition": competition,
        "match_time": match_time,
    }
