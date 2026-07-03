import os
from datetime import date
from loguru import logger
from telegram import Bot
from telegram.constants import ParseMode
from telegram.error import TelegramError

TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
CHANNEL = os.getenv("TELEGRAM_CHANNEL_ID", "")
SOURCES = ["Forebet", "PredictZ", "Footystats"]

def format_message(picks):
    today = date.today().strftime("%d/%m/%Y")
    lines = [f"🎯 *PRONOSTICS DU JOUR — {today}*", "━━━━━━━━━━━━━━━━━━━━━", ""]
    if not picks:
        return "\n".join(lines + ["⚠️ Aucun pronostic fiable aujourd'hui."])
    
    for pick in picks:
        outcome_label = {"1": f"1 (Victoire {pick['home_team']})", "X": "X (Nul)", "2": f"2 (Victoire {pick['away_team']})"}[pick["outcome"]]
        sources_str = " | ".join(f"{s} ✓" for s in SOURCES if s in pick["sources_list"])
        lines += [
            f"⚽ *{pick['home_team']} vs {pick['away_team']}*",
            f"🏆 {pick.get('competition') or '—'} — {pick.get('match_time') or '—'}",
            f"📊 {outcome_label}",
            f"🔒 Confiance : {pick['avg_probability']}% ({pick['sources_count']}/3 sources)",
            f"📡 {sources_str}", "", "---", ""
        ]
    while lines[-1] in ("---", ""): lines.pop()

    # COMBINÉ DU JOUR
    combo_picks = [p for p in picks if p["avg_probability"] >= 70 and p["sources_count"] >= 2][:3]
    if len(combo_picks) >= 2:
        lines += ["", "━━━━━━━━━━━━━━━━━━━━━", "🎰 *COMBINÉ DU JOUR*", ""]
        combo_odds = 1.0
        for p in combo_picks:
            implied_odd = round(100 / p["avg_probability"], 2)
            combo_odds *= implied_odd
            outcome_label = {"1": f"1 {p['home_team']}", "X": "Nul", "2": f"2 {p['away_team']}"}[p["outcome"]]
            lines.append(f"• {p['home_team']} vs {p['away_team']} → *{outcome_label}* (cote estimée {implied_odd})")
        lines += [
            "",
            f"💰 *Cote combinée estimée : {round(combo_odds, 2)}*",
            "⚠️ _Cotes estimées — vérifie chez ton bookmaker_"
        ]

    lines += ["", "━━━━━━━━━━━━━━━━━━━━━", f"📈 *{len(picks)} pronostic(s)* aujourd'hui", "⚠️ _Joue responsable_"]
    return "\n".join(lines)
