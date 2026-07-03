import re, time
import requests
from bs4 import BeautifulSoup
from loguru import logger

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"}
SOURCE_NAME = "Footystats"
BASE_URL = "https://footystats.org/predictions"

def _guess_outcome(text):
    text = text.lower()
    if any(w in text for w in ("home", "domicile", "win 1")): return "1"
    if any(w in text for w in ("draw", "nul", "egalite")): return "X"
    if any(w in text for w in ("away", "exterieur", "win 2")): return "2"
    return None

def scrape():
    predictions = []
    try:
        time.sleep(2)
        r = requests.get(BASE_URL, headers=HEADERS, timeout=20)
        r.raise_for_status()
    except Exception as e:
        logger.error(f"[{SOURCE_NAME}] Erreur: {e}")
        return predictions

    soup = BeautifulSoup(r.text, "lxml")
    cards = (soup.select("div.prediction-card, div.match-prediction, article.match") or
             soup.select("table.predictions-table tbody tr") or
             soup.select("div.match-row, div.fixture"))

    for card in cards:
        try:
            home, away, outcome, probability = "", "", None, 0.0
            home_el = card.find(class_=lambda c: c and "home" in c.lower())
            away_el = card.find(class_=lambda c: c and "away" in c.lower())
            if home_el: home = home_el.get_text(strip=True)
            if away_el: away = away_el.get_text(strip=True)
            if not home or not away:
                team_els = card.find_all(class_=lambda c: c and "team" in c.lower())
                if len(team_els) >= 2:
                    home, away = team_els[0].get_text(strip=True), team_els[1].get_text(strip=True)
            if not home or not away: continue
            pred_el = card.find(class_=lambda c: c and any(w in c.lower() for w in ("prediction", "tip", "pick")))
            if pred_el:
                raw = pred_el.get_text(strip=True).lower()
                if raw in ("1", "home win", "home"): outcome = "1"
                elif raw in ("x", "draw"): outcome = "X"
                elif raw in ("2", "away win", "away"): outcome = "2"
                else: outcome = _guess_outcome(raw)
            pcts = re.findall(r"(\d{1,3}(?:\.\d+)?)\s*%", card.get_text(" "))
            if pcts:
                vals = [float(p) for p in pcts if 0 < float(p) <= 100]
                if vals: probability = max(vals)
            if outcome:
                predictions.append({"source": SOURCE_NAME, "home_team": home, "away_team": away, "outcome": outcome, "probability": probability, "competition": "", "match_time": ""})
        except: continue

    logger.info(f"[{SOURCE_NAME}] {len(predictions)} prédictions")
    return predictions
