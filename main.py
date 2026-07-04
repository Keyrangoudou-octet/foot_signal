import argparse, asyncio, sys, time
import schedule
from dotenv import load_dotenv
from loguru import logger

load_dotenv()
from scrapers import api_football
from telegram_bot import format_message, send_message

logger.remove()
logger.add(sys.stderr, level="INFO")

def run_scrapers():
    raw = api_football.scrape()
    return [{
        **p,
        "avg_probability": round(p["probability"], 1),
        "sources_count": 1,
        "sources_list": ["APIFootball"],
    } for p in raw]

async def run_job():
    picks = run_scrapers()
    await send_message(format_message(picks))

def run_now(): asyncio.run(run_job())

def run_schedule():
    schedule.every().day.at("09:00").do(run_now)
    run_now()
    while True:
        schedule.run_pending()
        time.sleep(30)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--now", action="store_true")
    g.add_argument("--schedule", action="store_true")
    args = parser.parse_args()
    run_now() if args.now else run_schedule()
