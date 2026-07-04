import os
import time
from datetime import date
import requests
from loguru import logger

SOURCE_NAME = "APIFootball"
BASE_URL = "https://v3.football.api-sports.io"
API_KEY = os.getenv("API_FOOTBALL_KEY", "")

HEADERS = {
    "x-apisports-key": API_KEY,
}

MIN_PROBABILITY = 55.0


def _percent_to_float(pct_str):
    try:
        return float(str(pct_str).replace("%", "").strip())
    except (ValueError, TypeError):
        return 0.0


def _get_fixtures_today():
    today = date.today().strftime("%Y-%m-%d")
    url = f"{BASE_URL}/fixtures"
    params = {"date": today, "status": "NS"}
    try:
        resp = requests.get(url, headers=HEADERS, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        fixtures = data.get("response", [])
        logger.info(f"[{SOURCE_NAME}] {len(fixtures)} matchs trouvés pour {today}")
        return fixtures
    except Exception as e:
        logger.error(f"[{SOURCE_NAME}] Erreur fixtures : {e}")
        return []


def _get_prediction(fixture_id):
    url = f"{BASE_URL}/predictions"
    try:
        resp = requests.get(url, headers=HEADERS, params={"fixture": fixture_id}, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        results = data.get("response", [])
        return results[0] if results else None
    except Exception as e:
        logger.debug(f"[{SOURCE_NAME}] Pas de prédiction pour fixture {fixture_id} : {e}")
        return None


def scrape():
    if not API_KEY:
        logger.error(f"[{SOURCE_NAME}] API_FOOTBALL_KEY manquante")
        return []

    predictions = []
    fixtures = _get_fixtures_today()

    for fixture in fixtures[:80]:
        fixture_id = fixture["fixture"]["id"]
        home_team = fixture["teams"]["home"]["name"]
        away_team = fixture["teams"]["away"]["name"]
        competition = fixture["league"]["name"]
        match_time = fixture["fixture"]["date"][11:16]

        time.sleep(0.2)
        pred_data = _get_prediction(fixture_id)
        if not pred_data:
            continue

        preds = pred_data.get("predictions", {})
        percent = preds.get("percent", {})

        p_home = _percent_to_float(percent.get("home", "0%"))
        p_draw = _percent_to_float(percent.get("draw", "0%"))
        p_away = _percent_to_float(percent.get("away", "0%"))

        best_prob = max(p_home, p_draw, p_away)
        if best_prob < MIN_PROBABILITY:
            continue

        if p_home == best_prob:
            outcome = "1"
        elif p_draw == best_prob:
            outcome = "X"
        else:
            outcome = "2"

        predictions.append({
            "source": SOURCE_NAME,
            "home_team": home_team,
            "away_team": away_team,
            "outcome": outcome,
            "probability": best_prob,
            "competition": competition,
            "match_time": match_time,
        })

    logger.info(f"[{SOURCE_NAME}] {len(predictions)} prédictions retenues")
    return predictions
