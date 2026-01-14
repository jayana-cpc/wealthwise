import logging
import os
from datetime import datetime
from typing import Dict, List

import httpx

from backend.supabase_client import MarketPriceBar

logger = logging.getLogger("wealthwise.alpaca")


class MarketDataError(Exception):
    """Raised when Alpaca market data could not be retrieved."""


def _parse_ts(value: str) -> datetime:
    if value.endswith("Z"):
        value = value.replace("Z", "+00:00")
    return datetime.fromisoformat(value)


async def fetch_daily_bars(
    symbols: List[str],
    start: datetime,
    end: datetime,
    timeframe: str = "1Day",
    base_url_env: str = "ALPACA_DATA_BASE_URL",
    feed_env: str = "ALPACA_DATA_FEED",
) -> Dict[str, List[MarketPriceBar]]:
    """
    Fetch daily bars for the given symbols from Alpaca Market Data.

    Returns a mapping of symbol -> list of MarketPriceBar sorted by time.
    """
    if not symbols:
        return {}
    base_url = os.getenv(base_url_env, "https://data.alpaca.markets").rstrip("/")
    # Normalize in case someone sets paper-api or appends /v2.
    if base_url.endswith("/v2"):
        base_url = base_url[:-3]
    api_key = os.getenv("ALPACA_API_KEY")
    api_secret = os.getenv("ALPACA_SECRET")
    if not api_key or not api_secret:
        raise MarketDataError("Missing Alpaca API credentials.")

    headers = {
        "APCA-API-KEY-ID": api_key,
        "APCA-API-SECRET-KEY": api_secret,
    }
    url = f"{base_url}/v2/stocks/bars"
    params = {
        "symbols": ",".join(sorted(set(symbols))),
        "timeframe": timeframe,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "limit": 10000,
        # Use free IEX feed by default; avoids SIP-only subscription errors.
        "feed": os.getenv(feed_env, "iex"),
    }

    results: Dict[str, List[MarketPriceBar]] = {}

    async with httpx.AsyncClient(timeout=20.0) as client:
        next_token = None
        while True:
            req_params = dict(params)
            if next_token:
                req_params["page_token"] = next_token

            resp = await client.get(url, headers=headers, params=req_params)
            if resp.status_code in (401, 403):
                logger.warning(
                    "Alpaca auth/permission error: status=%s url=%s params=%s body=%s",
                    resp.status_code,
                    url,
                    {"symbols": req_params.get("symbols"), "timeframe": timeframe},
                    resp.text[:500],
                )
                raise MarketDataError("Alpaca authentication failed or insufficient permissions.")
            if resp.status_code == 429:
                logger.warning("Alpaca rate limit hit: status=429 url=%s", url)
                raise MarketDataError("Alpaca rate limit hit (429).")
            if resp.status_code >= 500:
                logger.warning(
                    "Alpaca service error: status=%s url=%s body=%s",
                    resp.status_code,
                    url,
                    resp.text[:500],
                )
                raise MarketDataError("Alpaca service error.")
            if resp.status_code >= 400:
                logger.warning(
                    "Alpaca request failed: status=%s url=%s params=%s body=%s",
                    resp.status_code,
                    url,
                    {"symbols": req_params.get("symbols"), "timeframe": timeframe},
                    resp.text[:500],
                )
                raise MarketDataError(f"Alpaca request failed: {resp.text}")

            data = resp.json()
            bars_payload = data.get("bars") or {}
            for sym, bar_list in bars_payload.items():
                sym_results = results.setdefault(sym, [])
                for item in bar_list:
                    try:
                        bar = MarketPriceBar(
                            symbol=sym,
                            timeframe=timeframe,
                            t=_parse_ts(item["t"]),
                            o=float(item["o"]),
                            h=float(item["h"]),
                            l=float(item["l"]),
                            c=float(item["c"]),
                            v=item.get("v"),
                            source="alpaca",
                        )
                        sym_results.append(bar)
                    except Exception:
                        continue

            next_token = data.get("next_page_token")
            if not next_token:
                break

    for sym in list(results.keys()):
        results[sym] = sorted(results[sym], key=lambda b: b.t)

    return results
