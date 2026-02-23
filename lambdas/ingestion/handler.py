"""
Stock Pulse — Data Ingestion Lambda Handler

Fetches real-time stock quotes from Finnhub, processes them into
enriched records with technical indicators, and stores in DynamoDB.
Triggered by EventBridge every 5 minutes.
"""

import json
import os
import time
import logging
from datetime import datetime, timezone
from decimal import Decimal

import boto3
import requests

# ── Config ──────────────────────────────────────────────────
logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE_NAME = os.environ["TABLE_NAME"]
FINNHUB_API_KEY = os.environ["FINNHUB_API_KEY"]
TRACKED_SYMBOLS = os.environ.get("TRACKED_SYMBOLS", "AAPL,GOOGL,MSFT,AMZN,TSLA").split(",")
FINNHUB_BASE_URL = "https://finnhub.io/api/v1"
TTL_DAYS = 7

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)


def fetch_quote(symbol: str) -> dict | None:
    """Fetch real-time quote from Finnhub for a single symbol."""
    try:
        resp = requests.get(
            f"{FINNHUB_BASE_URL}/quote",
            params={"symbol": symbol, "token": FINNHUB_API_KEY},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

        # Finnhub returns {"c":0,"d":null,...} for invalid symbols
        if data.get("c", 0) == 0:
            logger.warning(f"No data returned for {symbol}")
            return None

        return data
    except requests.RequestException as e:
        logger.error(f"Failed to fetch quote for {symbol}: {e}")
        return None


def fetch_company_profile(symbol: str) -> dict:
    """Fetch company profile for display name and logo."""
    try:
        resp = requests.get(
            f"{FINNHUB_BASE_URL}/stock/profile2",
            params={"symbol": symbol, "token": FINNHUB_API_KEY},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException:
        return {}


def classify_volume(current_volume: float) -> str:
    """Classify volume into categories based on common thresholds."""
    if current_volume < 10_000_000:
        return "low"
    elif current_volume < 50_000_000:
        return "normal"
    else:
        return "high"


def determine_signal(current: float, open_price: float, prev_close: float) -> str:
    """Determine bullish/bearish/neutral signal."""
    change_from_open = ((current - open_price) / open_price * 100) if open_price else 0
    change_from_close = ((current - prev_close) / prev_close * 100) if prev_close else 0

    if change_from_open > 0.5 and change_from_close > 0.5:
        return "bullish"
    elif change_from_open < -0.5 and change_from_close < -0.5:
        return "bearish"
    else:
        return "neutral"


def is_market_open() -> bool:
    """Check if US stock market is roughly open (9:30 AM - 4:00 PM ET, weekdays)."""
    now = datetime.now(timezone.utc)
    # Rough ET offset (UTC-5 / UTC-4 for DST — simplified)
    et_hour = (now.hour - 5) % 24
    weekday = now.weekday()  # 0=Monday, 6=Sunday

    if weekday >= 5:  # weekend
        return False
    if 9 <= et_hour < 16:  # 9 AM - 4 PM ET (simplified)
        return True
    return False


def process_quote(symbol: str, raw: dict) -> dict:
    """Enrich raw Finnhub quote with derived metrics."""
    now = datetime.now(timezone.utc)
    timestamp = int(now.timestamp())

    current = raw["c"]        # Current price
    open_price = raw["o"]     # Open
    high = raw["h"]           # High
    low = raw["l"]            # Low
    prev_close = raw["pc"]    # Previous close

    change = round(current - prev_close, 4)
    change_pct = round((change / prev_close * 100), 4) if prev_close else 0
    intraday_range = round(high - low, 4)

    return {
        "pk": f"STOCK#{symbol}",
        "sk": timestamp,
        "symbol": symbol,
        "current_price": Decimal(str(round(current, 4))),
        "open": Decimal(str(round(open_price, 4))),
        "high": Decimal(str(round(high, 4))),
        "low": Decimal(str(round(low, 4))),
        "previous_close": Decimal(str(round(prev_close, 4))),
        "change": Decimal(str(change)),
        "change_percent": Decimal(str(change_pct)),
        "intraday_range": Decimal(str(intraday_range)),
        "signal": determine_signal(current, open_price, prev_close),
        "market_open": is_market_open(),
        "day_of_week": now.strftime("%A"),
        "ingestion_time": now.isoformat(),
        "ttl": timestamp + (TTL_DAYS * 86400),
    }


def store_records(records: list[dict]):
    """Batch-write processed records + latest snapshot to DynamoDB."""
    with table.batch_writer() as batch:
        for record in records:
            # Write time-series record
            batch.put_item(Item=record)

            # Write/overwrite LATEST record for quick dashboard queries
            latest = {**record}
            latest["pk"] = f"LATEST#{record['symbol']}"
            latest["sk"] = 0  # Fixed sort key for latest
            batch.put_item(Item=latest)

    logger.info(f"Stored {len(records)} records + {len(records)} LATEST snapshots")


def handler(event, context):
    """Lambda entry point — triggered by EventBridge."""
    logger.info(f"Ingestion triggered at {datetime.now(timezone.utc).isoformat()}")
    logger.info(f"Tracking symbols: {TRACKED_SYMBOLS}")

    processed_records = []
    errors = []

    for symbol in TRACKED_SYMBOLS:
        symbol = symbol.strip().upper()
        raw = fetch_quote(symbol)
        if raw:
            record = process_quote(symbol, raw)
            processed_records.append(record)
            logger.info(
                f"  {symbol}: ${record['current_price']} "
                f"({'+' if record['change'] >= 0 else ''}{record['change_percent']}%) "
                f"[{record['signal']}]"
            )
        else:
            errors.append(symbol)

    if processed_records:
        store_records(processed_records)

    result = {
        "statusCode": 200,
        "body": json.dumps({
            "message": "Ingestion complete",
            "processed": len(processed_records),
            "errors": errors,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }),
    }

    logger.info(f"Done: {len(processed_records)} processed, {len(errors)} errors")
    return result
