import argparse, asyncio, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
import schedule
from dotenv import load_dotenv
from loguru import logger

load_dotenv()
from aggregator import aggregate_predictions
from scrapers import forebet, predictz, footystats
from telegram_bot import format_message, send_message

logger.remove()
logger.add(sys.stderr, level="INFO")

def run_scrapers():
    all_predictions = []
    jobs = {"Forebet": forebet.scrape, "PredictZ": predictz.scrape, "Footystats": footystats.scrape}
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(fn): name for name, fn in jobs.items()}
        for f in as_completed(futures):
            try:
                all_predictions.extend(f.result())
            except Exception as e:
                logger.error(f"{futures[f]} erreur: {e}")
    return all_predictions

async def run_job():
    preds = run_scrapers()
    picks = aggregate_predictions(preds)
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
