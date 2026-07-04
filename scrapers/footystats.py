import time
import re
import requests
from bs4 import BeautifulSoup
from loguru import logger

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://footystats.org/",
}

SOURCE_NAME = "Footystats"
BASE_URL = "https://footystats.org/predictions"


def scrape():
    predictions = []
    try:
        logger.info(f"[{SOURCE_NAME}] Scraping — {BASE_URL}")
        time.sleep(2)
        response = requests.get(BASE_URL, headers=HEADERS, timeout=20)
        response.raise_for_status()
    except requests.RequestException as exc:
        logger.error(f"[{SOURCE_NAME}] Erreur réseau : {exc}")
        return predictions

    soup = BeautifulSoup(response.text, "lxml")
    cards = soup.select("div.prediction-card, div.match-prediction, article.match")
    if not cards:
        cards = soup.select("table.predictions-table tbody tr")
    if not cards:
        cards = soup.select("div.match-row, div.fixture")

    logger.info(f"[{SOURCE_NAME}] {len(cards)} éléments trouvés")

    for card in cards:
        try:
            pred = _parse_card(card)
            if pred:
                predictions.append(pred)
        except Exception as exc:
            logger.debug(f"[{SOURCE_NAME}] Ignoré : {exc}")

    logger.info(f"[{SOURCE_NAME}] {len(predictions)} prédictions extraites")
    return predictions


def _parse_card(card):
    home_team = ""
    away_team = ""
    outcome = None
    probability = 0.0
    competition = ""
    match_time = ""

    home_el = card.find(class_=lambda c: c and ("home" in c.lower() or "team-home" in c.lower()))
    away_el = card.find(class_=lambda c: c and ("away" in c.lower() or "team-away" in c.lower()))
    if home_el:
        home_team = home_el.get_text(strip=True)
    if away_el:
        away_team = away_el.get_text(strip=True)

    if not home_team or not away_team:
        team_els = card.find_all(class_=lambda c: c and "team" in c.lower())
        if len(team_els) >= 2:
            home_team = team_els[0].get_text(strip=True)
            away_team = team_els[1].get_text(strip=True)

    if not home_team or not away_team:
        cells = card.find_all("td")
        if len(cells) >= 2:
            texts = [c.get_text(strip=True) for c in cells]
            home_team, away_team = texts[0], texts[1]

    if not home_team or not away_team:
        return None

    comp_el = card.find(class_=lambda c: c and any(w in c.lower() for w in ("league", "competition", "tournament")))
    if comp_el:
        competition = comp_el.get_text(strip=True)

    time_el = card.find(class_=lambda c: c and any(w in c.lower() for w in ("time", "kickoff")))
    if time_el:
        match_time = time_el.get_text(strip=True)

    pred_el = card.find(class_=lambda c: c and any(w in c.lower() for w in ("prediction", "tip", "pick")))
    if pred_el:
        raw = pred_el.get_text(strip=True).lower()
        if raw in ("1", "home win", "home"):
            outcome = "1"
        elif raw in ("x", "draw"):
            outcome = "X"
        elif raw in ("2", "away win", "away"):
            outcome = "2"
        else:
            outcome = _guess_outcome(raw)

    pcts = re.findall(r"(\d{1,3}(?:\.\d+)?)\s*%", card.get_text(" "))
    if pcts:
        vals = [float(p) for p in pcts if 0 < float(p) <= 100]
        if vals:
            probability = max(vals)

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


def _guess_outcome(text):
    text = text.lower()
    if any(w in text for w in ("home", "domicile")):
        return "1"
    if any(w in text for w in ("draw", "nul")):
        return "X"
    if any(w in text for w in ("away", "extérieur", "exterieur")):
        return "2"
    return None
