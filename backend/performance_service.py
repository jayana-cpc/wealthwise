import logging
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Tuple
from fastapi import HTTPException
from pydantic import BaseModel

from backend.alpaca_client import MarketDataError, fetch_daily_bars
from backend.auth import SessionUser
from backend.csv_parsing import PositionsPayload
from backend.supabase_client import (
    PortfolioImportBatch,
    fetch_latest_import_batch,
    fetch_latest_transactions_upload,
    load_cached_market_price_bars,
    upsert_market_price_bars,
)

logger = logging.getLogger("wealthwise.performance")

DEFAULT_BENCHMARKS = ["SPY", "IWM"]
_MEMORY_PRICE_CACHE: Dict[str, List] = {}


class PricePoint(BaseModel):
    date: str
    value: float


class PortfolioPoint(PricePoint):
    equity: float
    cash: float


class PositionState(BaseModel):
    date: str
    shares: Dict[str, float]
    cash: float


class HoldingSummary(BaseModel):
    symbol: str
    description: str
    shares: float
    current_value: float
    cost_basis: Optional[float] = None
    gain_abs: Optional[float] = None
    gain_pct: Optional[float] = None


class PerformanceResponse(BaseModel):
    start_date: str
    end_date: str
    symbols: List[str]
    benchmarks: List[str]
    portfolio: List[PortfolioPoint]
    benchmark_series: Dict[str, List[PricePoint]]
    price_series: Dict[str, List[PricePoint]]
    positions: List[PositionState]
    holdings: List[HoldingSummary]
    warnings: List[str]


@dataclass
class Txn:
    date: date
    action: str
    symbol: Optional[str]
    quantity: Decimal
    price: Optional[Decimal]
    amount: Decimal


def _parse_date(raw: str) -> date:
    """
    Best-effort date parser for brokerage exports.

    Supports:
    - 12/31/2025
    - 12-31-2025
    - 2025-12-31
    - Strings with "as of" or other text around the date.
    Falls back to today's date if no token is found.
    """
    if isinstance(raw, date):
        return raw
    text = str(raw or "").lower()
    text = text.replace("as of", " ")
    match = re.search(r"(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})", text)
    if not match:
        return datetime.utcnow().date()
    token = match.group(1)
    token = token.replace("-", "/")
    parts = token.split("/")
    if len(parts) != 3:
        return datetime.utcnow().date()
    if len(parts[0]) == 4:  # yyyy/mm/dd
        year = int(parts[0])
        month = int(parts[1])
        day = int(parts[2])
    else:  # mm/dd/yy or mm/dd/yyyy
        month = int(parts[0])
        day = int(parts[1])
        year = int(parts[2])
        if year < 100:
            year += 2000
    try:
        return date(year, month, day)
    except Exception:
        return datetime.utcnow().date()


def _parse_decimal(raw: str) -> Decimal:
    value = raw.replace("$", "").replace(",", "").strip()
    if value.startswith("(") and value.endswith(")"):
        value = f"-{value[1:-1]}"
    if value == "" or value == "--":
        return Decimal("0")
    try:
        return Decimal(value)
    except InvalidOperation:
        return Decimal("0")


def _parse_transactions_payload(payload: Dict[str, Any]) -> List[Txn]:
    items = payload.get("BrokerageTransactions") or []
    txns: List[Txn] = []
    for item in items:
        try:
            raw_date = item.get("Date") or item.get("date") or ""
            txn_date = _parse_date(raw_date)
            txns.append(
                Txn(
                    date=txn_date,
                    action=(item.get("Action") or item.get("action") or "").strip().upper(),
                    symbol=(item.get("Symbol") or "").strip().upper() or None,
                    quantity=_parse_decimal(item.get("Quantity") or item.get("quantity") or "0"),
                    price=_parse_decimal(item.get("Price") or item.get("price") or "0"),
                    amount=_parse_decimal(item.get("Amount") or item.get("amount") or "0"),
                )
            )
        except Exception as exc:
            logger.warning("Falling back for transaction due to parse error: %s", exc)
            txns.append(
                Txn(
                    date=datetime.utcnow().date(),
                    action=str(item.get("Action") or "UNKNOWN").strip().upper(),
                    symbol=(item.get("Symbol") or "").strip().upper() or None,
                    quantity=Decimal("0"),
                    price=None,
                    amount=Decimal("0"),
                )
            )
    txns.sort(key=lambda t: t.date)
    return txns


def _symbols_from_positions(payload: PositionsPayload) -> List[str]:
    symbols: List[str] = []
    for row in payload.rows:
        symbol = (row.symbol or "").strip().upper()
        if not symbol or row.row_type != "position":
            continue
        if symbol not in symbols:
            symbols.append(symbol)
    return symbols


def _action_to_delta(action: str, qty: Decimal, amount: Decimal) -> Tuple[Decimal, Decimal]:
    action_upper = action.upper()
    if action_upper == "BUY":
        return qty, amount
    if action_upper == "SELL":
        return -qty, amount
    if "DIVIDEND" in action_upper or "INTEREST" in action_upper:
        return Decimal("0"), amount
    if "TRANSFER" in action_upper:
        return Decimal("0"), amount
    return Decimal("0"), Decimal("0")


def _baseline_positions(
    txns: List[Txn], target_shares: Dict[str, Decimal], target_cash: Decimal
) -> Tuple[Dict[str, Decimal], Decimal, Dict[str, Decimal]]:
    """
    Determine starting shares/cash so that:
    - Running positions never go negative.
    - Ending state lines up with target_shares and target_cash.
    Returns (baseline_shares, initial_cash, net_changes_by_symbol).
    """
    running: Dict[str, Decimal] = {}
    min_seen: Dict[str, Decimal] = {}
    net_changes: Dict[str, Decimal] = {}
    cash = Decimal("0")
    for txn in txns:
        delta_shares, delta_cash = _action_to_delta(txn.action, txn.quantity, txn.amount)
        if txn.symbol:
            prev = running.get(txn.symbol, Decimal("0"))
            running[txn.symbol] = prev + delta_shares
            net_changes[txn.symbol] = net_changes.get(txn.symbol, Decimal("0")) + delta_shares
            min_seen[txn.symbol] = min(min_seen.get(txn.symbol, Decimal("0")), running[txn.symbol])
        cash += delta_cash

    baseline: Dict[str, Decimal] = {}
    for sym in set(list(net_changes.keys()) + list(target_shares.keys())):
        net = net_changes.get(sym, Decimal("0"))
        needed_for_negatives = -min_seen.get(sym, Decimal("0"))
        needed_for_target = target_shares.get(sym, Decimal("0")) - net
        baseline[sym] = max(Decimal("0"), needed_for_negatives, needed_for_target)

    initial_cash = max(Decimal("0"), target_cash - cash)
    return baseline, initial_cash, net_changes


def _positions_timeline(
    txns: List[Txn], baseline_shares: Dict[str, Decimal], initial_cash: Decimal, start: date, end: date
) -> List[PositionState]:
    positions: List[PositionState] = []
    current_shares = dict(baseline_shares)
    cash = initial_cash
    txns_by_date: Dict[date, List[Txn]] = {}
    for txn in txns:
        txns_by_date.setdefault(txn.date, []).append(txn)

    cursor = start
    while cursor <= end:
        for txn in txns_by_date.get(cursor, []):
            delta_shares, delta_cash = _action_to_delta(txn.action, txn.quantity, txn.amount)
            if txn.symbol:
                current_shares[txn.symbol] = current_shares.get(txn.symbol, Decimal("0")) + delta_shares
            cash += delta_cash
        positions.append(
            PositionState(
                date=cursor.isoformat(),
                shares={sym: float(val) for sym, val in current_shares.items()},
                cash=float(cash),
            )
        )
        cursor += timedelta(days=1)
    return positions


def _supabase_available() -> bool:
    return bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_SERVICE_ROLE_KEY"))


def _merge_bars(existing: Dict[str, List], fresh: Dict[str, List]) -> Dict[str, List]:
    merged: Dict[str, List] = {}
    for sym in set(existing.keys()) | set(fresh.keys()):
        combined = (existing.get(sym) or []) + (fresh.get(sym) or [])
        seen = {}
        for bar in combined:
            seen[bar.t] = bar
        merged[sym] = sorted(seen.values(), key=lambda b: b.t)
    return merged


def _has_coverage(bars: List, start_dt: datetime, end_dt: datetime) -> bool:
    if not bars:
        return False
    first = bars[0].t
    last = bars[-1].t
    return first <= start_dt and last >= end_dt and len(bars) >= 5


async def _load_market_bars(
    symbols: List[str], start_dt: datetime, end_dt: datetime, warnings: List[str]
) -> Dict[str, List]:
    cached: Dict[str, List] = {}
    # In-memory cache check first
    memory_hits: Dict[str, List] = {}
    for sym in symbols:
        bars = _MEMORY_PRICE_CACHE.get(sym, [])
        if _has_coverage(bars, start_dt, end_dt):
            memory_hits[sym] = bars

    # Supabase cache next
    if _supabase_available():
        try:
            cached = load_cached_market_price_bars(symbols, start_dt, end_dt, timeframe="1Day")
        except Exception as exc:
            warnings.append(f"Cache unavailable, fetching fresh prices only ({exc}).")
            cached = {}

    merged_cache = _merge_bars(memory_hits, cached)

    missing = []
    for sym in symbols:
        bars = merged_cache.get(sym)
        if not _has_coverage(bars or [], start_dt, end_dt):
            missing.append(sym)

    fresh: Dict[str, List] = {}
    if missing:
        fresh = await fetch_daily_bars(missing, start_dt, end_dt, timeframe="1Day")
        if fresh and _supabase_available():
            try:
                upsert_market_price_bars([bar for bars in fresh.values() for bar in bars])
            except Exception as exc:
                warnings.append(f"Could not persist price cache: {exc}")

    combined = _merge_bars(merged_cache, fresh)
    # Update in-memory cache with any new coverage
    for sym, bars in combined.items():
        if bars:
            _MEMORY_PRICE_CACHE[sym] = bars
    return combined


def _price_history_from_bars(
    bars_by_symbol: Dict[str, List], fallback_prices: Dict[str, float], start: date, end: date, warnings: List[str]
) -> Dict[str, List[PricePoint]]:
    history: Dict[str, List[PricePoint]] = {}
    for sym, bars in bars_by_symbol.items():
        if not bars:
            continue
        points: List[PricePoint] = []
        for bar in bars:
            bar_date = bar.t.date()
            if bar_date < start or bar_date > end:
                continue
            points.append(PricePoint(date=bar_date.isoformat(), value=float(bar.c)))
        if points:
            history[sym] = points
    for sym, price in fallback_prices.items():
        if sym in history:
            continue
        history[sym] = [
            PricePoint(date=start.isoformat(), value=price),
            PricePoint(date=end.isoformat(), value=price),
        ]
        warnings.append(f"No Alpaca data for {sym}; using static price ${price:.2f}.")
    return history


def _lookup_price(series: List[PricePoint], target: date) -> Optional[float]:
    price: Optional[float] = None
    for point in series:
        point_date = datetime.strptime(point.date, "%Y-%m-%d").date()
        if point_date <= target:
            price = point.value
        else:
            break
    return price


def _portfolio_series(
    positions: List[PositionState], price_history: Dict[str, List[PricePoint]]
) -> List[PortfolioPoint]:
    series: List[PortfolioPoint] = []
    for state in positions:
        d = datetime.strptime(state.date, "%Y-%m-%d").date()
        equity = 0.0
        for sym, shares in state.shares.items():
            price = _lookup_price(price_history.get(sym, []), d)
            if price is None:
                continue
            equity += shares * price
        series.append(
            PortfolioPoint(
                date=state.date,
                value=equity + state.cash,
                equity=equity,
                cash=state.cash,
            )
        )
    return series


def _gain_pct(start: float, end: float) -> Optional[float]:
    if start == 0:
        return None
    return (end - start) / start


def _holdings_summary(
    payload: PositionsPayload,
    positions: List[PositionState],
    price_history: Dict[str, List[PricePoint]],
) -> List[HoldingSummary]:
    if not positions:
        return []
    start_date = datetime.strptime(positions[0].date, "%Y-%m-%d").date()
    end_date = datetime.strptime(positions[-1].date, "%Y-%m-%d").date()

    symbol_to_cost: Dict[str, float] = {}
    holdings: List[HoldingSummary] = []
    for row in payload.rows:
        if row.row_type != "position":
            continue
        sym = (row.symbol or "").strip().upper()
        cost = float(row.cost_basis) if row.cost_basis is not None else None
        symbol_to_cost[sym] = cost if cost is not None else 0.0

    start_shares_by_sym = positions[0].shares
    end_shares_by_sym = positions[-1].shares

    for sym, end_shares in end_shares_by_sym.items():
        series = price_history.get(sym, [])
        price_start = _lookup_price(series, start_date) or 0.0
        price_end = _lookup_price(series, end_date) or 0.0
        start_value = price_start * start_shares_by_sym.get(sym, 0.0)
        end_value = price_end * end_shares
        cost_basis = symbol_to_cost.get(sym)
        gain_abs = end_value - start_value
        gain_pct = _gain_pct(start_value, end_value)
        holdings.append(
            HoldingSummary(
                symbol=sym,
                description="",
                shares=end_shares,
                current_value=end_value,
                cost_basis=cost_basis,
                gain_abs=gain_abs,
                gain_pct=gain_pct,
            )
        )

    # Preserve metadata descriptions when available
    for row in payload.rows:
        if row.row_type != "position":
            continue
        sym = (row.symbol or "").strip().upper()
        for item in holdings:
            if item.symbol == sym and not item.description:
                item.description = row.description
    return sorted(holdings, key=lambda h: h.symbol)


def _fallback_prices_from_positions(payload: PositionsPayload) -> Dict[str, float]:
    prices: Dict[str, float] = {}
    for row in payload.rows:
        if row.row_type != "position":
            continue
        sym = (row.symbol or "").strip().upper()
        if not sym:
            continue
        if row.price is not None:
            try:
                prices[sym] = float(row.price)
                continue
            except Exception:
                pass
        if row.cost_basis and row.quantity and row.quantity > 0:
            try:
                prices[sym] = float(row.cost_basis / row.quantity)
            except Exception:
                continue
    return prices


def _fallback_prices_from_transactions(txns: List[Txn]) -> Dict[str, float]:
    prices: Dict[str, float] = {}
    for txn in txns:
        if not txn.symbol or txn.quantity <= 0:
            continue
        if txn.price and txn.price > 0:
            prices.setdefault(txn.symbol, float(txn.price))
    return prices


async def build_performance_payload(user: SessionUser) -> PerformanceResponse:
    batch: Optional[PortfolioImportBatch] = fetch_latest_import_batch(user)
    if not batch:
        raise HTTPException(status_code=404, detail="No holdings upload found. Upload a CSV first.")
    positions_payload = batch.payload

    tx_upload = fetch_latest_transactions_upload(user)
    if not tx_upload:
        raise HTTPException(
            status_code=404,
            detail="No transactions upload found. Upload a transactions JSON file first.",
        )

    txns = _parse_transactions_payload(tx_upload.payload)
    if not txns:
        raise HTTPException(status_code=400, detail="No transactions could be parsed.")

    holdings_symbols = _symbols_from_positions(positions_payload)
    txn_symbols = [t.symbol for t in txns if t.symbol]
    symbols = sorted(set(holdings_symbols + txn_symbols))

    target_cash = Decimal("0")
    for row in positions_payload.rows:
        if row.row_type == "cash" and row.market_value is not None:
            target_cash = Decimal(row.market_value)
            break

    target_shares: Dict[str, Decimal] = {}
    for row in positions_payload.rows:
        if row.row_type != "position":
            continue
        sym = (row.symbol or "").strip().upper()
        if not sym:
            continue
        target_shares[sym] = Decimal(row.quantity) if row.quantity is not None else Decimal("0")

    all_dates = [t.date for t in txns]
    start_date = min(all_dates) - timedelta(days=1)
    end_date = max(all_dates)
    now_cutoff = datetime.now(timezone.utc) - timedelta(minutes=20)
    if end_date > now_cutoff.date():
        end_date = now_cutoff.date()

    baseline_shares, initial_cash, _ = _baseline_positions(txns, target_shares, target_cash)
    positions = _positions_timeline(txns, baseline_shares, initial_cash, start_date, end_date)

    warnings: List[str] = []
    start_dt = datetime.combine(start_date, time.min, tzinfo=timezone.utc)
    end_dt = datetime.combine(end_date, time(hour=23, minute=40), tzinfo=timezone.utc)

    bars_by_symbol: Dict[str, List] = {}
    try:
        bars_by_symbol = await _load_market_bars(symbols + DEFAULT_BENCHMARKS, start_dt, end_dt, warnings)
    except MarketDataError as exc:
        warnings.append(f"Alpaca market data error: {exc}. Falling back to static prices.")
    except Exception as exc:
        warnings.append(f"Market data unavailable: {exc}. Using static prices.")

    fallback_prices = _fallback_prices_from_positions(positions_payload)
    txn_price_hints = _fallback_prices_from_transactions(txns)
    fallback_prices.update({k: v for k, v in txn_price_hints.items() if k not in fallback_prices})
    for bmk in DEFAULT_BENCHMARKS:
        fallback_prices.setdefault(bmk, 100.0)
    price_history = _price_history_from_bars(bars_by_symbol, fallback_prices, start_date, end_date, warnings)

    portfolio_series = _portfolio_series(positions, price_history)

    benchmark_series: Dict[str, List[PricePoint]] = {}
    for bmk in DEFAULT_BENCHMARKS:
        if bmk in price_history:
            benchmark_series[bmk] = price_history[bmk]

    holdings = _holdings_summary(positions_payload, positions, price_history)

    response = PerformanceResponse(
        start_date=start_date.isoformat(),
        end_date=end_date.isoformat(),
        symbols=symbols,
        benchmarks=DEFAULT_BENCHMARKS,
        portfolio=portfolio_series,
        benchmark_series=benchmark_series,
        price_series=price_history,
        positions=positions,
        holdings=holdings,
        warnings=warnings,
    )
    return response
