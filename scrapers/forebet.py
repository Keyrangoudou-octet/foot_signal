"""
Scraper pour Forebet (forebet.com) — prédictions mathématiques.
"""

import time
from datetime import date

import requests
from bs4 import BeautifulSoup
from loguru import logger

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.forebet.com/",
}

SOURCE_NAME = "Forebet"
BASE_URL = "https://www.forebet.com/en/predictions/predictions-1"


def _outcome_from_scores(score1, score2):
    try:
        s1, s2 = int(score1.strip()), int(score2.strip())
        if s1 > s2: return "1"
        elif s1 == s2: return "X"
        else: return "2"
    except (ValueError, AttributeError):
        return None


def scrape():
    predictions = []
    try:
        logger.info(f"[{SOURCE_NAME}] Scraping — {BASE_URL}")
        time.sleep(1)
        response = requests.get(BASE_URL, headers=HEADERS, timeout=20)
        response.raise_for_status()
    except requests.RequestException as exc:
        logger.error(f"[{SOURCE_NAME}] Erreur réseau : {exc}")
        return predictions

    soup = BeautifulSoup(response.text, "lxml")
    rows = soup.select("table.schema tr.tr_0, table.schema tr.tr_1")
    if not rows:
        rows = soup.select("div.rcnt")
        logger.debug(f"[{SOURCE_NAME}] Fallback div.rcnt — {len(rows)} éléments")

    logger.info(f"[{SOURCE_NAME}] {len(rows)} lignes trouvées")

    for row in rows:
        try:
            pred = _parse_row(row)
            if pred:
                predictions.append(pred)
        except Exception as exc:
            logger.debug(f"[{SOURCE_NAME}] Ligne ignorée : {exc}")

    logger.info(f"[{SOURCE_NAME}] {len(predictions)} prédictions extraites")
    return predictions


def _parse_row(row):
    cells = row.find_all("td")
    if len(cells) < 6:
        return None

    time_cell = cells[0].get_text(strip=True)
    teams_cell = cells[1]
    team_links = teams_cell.find_all("a")
    if len(team_links) >= 2:
        home_team = team_links[0].get_text(strip=True)
        away_team = team_links[1].get_text(strip=True)
    else:
        parts = [p.strip() for p in teams_cell.get_text(" ", strip=True).split("-") if p.strip()]
        if len(parts) < 2:
            return None
        home_team, away_team = parts[0], parts[1]

    if not home_team or not away_team:
        return None

    competition = ""
    comp_span = row.find("span", class_=lambda c: c and "league" in c.lower())
    if comp_span:
        competition = comp_span.get_text(strip=True)

    outcome = None
    probability = None

    for cell in cells:
        text = cell.get_text(strip=True)
        if "-" in text and len(text) <= 5:
            parts = text.split("-")
            if len(parts) == 2 and all(p.isdigit() for p in parts):
                outcome = _outcome_from_scores(parts[0], parts[1])
        if "%" in text:
            pct = text.replace("%", "").strip()
            try:
                val = float(pct)
                if 0 < val <= 100:
                    probability = val
            except ValueError:
                pass

    if outcome is None:
        for cell in cells:
            txt = cell.get_text(strip=True)
            if txt in ("1", "X", "2"):
                outcome = txt
                break

    if not outcome:
        return None

    return {
        "source": SOURCE_NAME,
        "home_team": home_team,
        "away_team": away_team,
        "outcome": outcome,
        "probability": probability or 0.0,
        "competition": competition,
        "match_time": time_cell,
    }
