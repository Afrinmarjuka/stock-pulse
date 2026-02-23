"""
Stock Pulse — API Lambda Handler

Serves stock data from DynamoDB to the frontend dashboard via API Gateway.
Handles three endpoints:
  GET /stocks              → Latest data for all tracked symbols
  GET /stocks/{symbol}     → Last 24h of data for a symbol
  GET /stocks/{symbol}/history → Last 7 days of data for a symbol
"""

import json
import os
import time
import logging
from datetime import datetime, timezone
from decimal import Decimal
from boto3.dynamodb.conditions import Key

import boto3

# ── Config ──────────────────────────────────────────────────
logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE_NAME = os.environ["TABLE_NAME"]
TRACKED_SYMBOLS = os.environ.get("TRACKED_SYMBOLS", "AAPL,GOOGL,MSFT,AMZN,TSLA").split(",")

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Content-Type": "application/json",
}


class DecimalEncoder(json.JSONEncoder):
    """Handle Decimal types from DynamoDB."""
    def default(self, obj):
        if isinstance(obj, Decimal):
            if obj % 1 == 0:
                return int(obj)
            return float(obj)
        return super().default(obj)


def json_response(status_code: int, body: dict) -> dict:
    """Create API Gateway proxy response with CORS headers."""
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, cls=DecimalEncoder),
    }


def get_all_latest() -> dict:
    """Fetch latest data for all tracked symbols."""
    items = []
    for symbol in TRACKED_SYMBOLS:
        symbol = symbol.strip().upper()
        try:
            response = table.get_item(
                Key={"pk": f"LATEST#{symbol}", "sk": 0}
            )
            if "Item" in response:
                item = response["Item"]
                # Clean up internal keys for API response
                item.pop("pk", None)
                item.pop("sk", None)
                item.pop("ttl", None)
                items.append(item)
        except Exception as e:
            logger.error(f"Error fetching latest for {symbol}: {e}")

    return json_response(200, {
        "stocks": items,
        "count": len(items),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


def get_symbol_recent(symbol: str) -> dict:
    """Fetch last 24h of data for a specific symbol (for sparkline charts)."""
    symbol = symbol.strip().upper()
    cutoff = int(time.time()) - 86400  # 24 hours ago

    try:
        response = table.query(
            KeyConditionExpression=Key("pk").eq(f"STOCK#{symbol}") & Key("sk").gte(cutoff),
            ScanIndexForward=True,  # Oldest first
        )
        items = response.get("Items", [])

        # Clean up internal keys
        for item in items:
            item.pop("pk", None)
            item.pop("ttl", None)

        return json_response(200, {
            "symbol": symbol,
            "data": items,
            "count": len(items),
            "period": "24h",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.error(f"Error fetching recent data for {symbol}: {e}")
        return json_response(500, {"error": f"Failed to fetch data for {symbol}"})


def get_symbol_history(symbol: str) -> dict:
    """Fetch last 7 days of data for a specific symbol (for detailed chart)."""
    symbol = symbol.strip().upper()
    cutoff = int(time.time()) - (7 * 86400)  # 7 days ago

    try:
        response = table.query(
            KeyConditionExpression=Key("pk").eq(f"STOCK#{symbol}") & Key("sk").gte(cutoff),
            ScanIndexForward=True,
        )
        items = response.get("Items", [])

        # Clean up internal keys
        for item in items:
            item.pop("pk", None)
            item.pop("ttl", None)

        return json_response(200, {
            "symbol": symbol,
            "data": items,
            "count": len(items),
            "period": "7d",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.error(f"Error fetching history for {symbol}: {e}")
        return json_response(500, {"error": f"Failed to fetch history for {symbol}"})


def handler(event, context):
    """Lambda entry point — invoked by API Gateway."""
    logger.info(f"API request: {json.dumps(event)}")

    http_method = event.get("httpMethod", "GET")
    path = event.get("path", "/")
    path_params = event.get("pathParameters") or {}

    # Handle CORS preflight
    if http_method == "OPTIONS":
        return json_response(200, {})

    # Route: GET /stocks
    if path == "/stocks" and http_method == "GET":
        return get_all_latest()

    # Route: GET /stocks/{symbol}/history
    if path_params.get("symbol") and path.endswith("/history") and http_method == "GET":
        return get_symbol_history(path_params["symbol"])

    # Route: GET /stocks/{symbol}
    if path_params.get("symbol") and http_method == "GET":
        return get_symbol_recent(path_params["symbol"])

    # 404 — unknown route
    return json_response(404, {
        "error": "Not found",
        "available_routes": [
            "GET /stocks",
            "GET /stocks/{symbol}",
            "GET /stocks/{symbol}/history",
        ],
    })
