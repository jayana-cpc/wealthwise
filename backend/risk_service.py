import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from fastapi import HTTPException

from backend.alpaca_client import MarketDataError, fetch_daily_bars
from backend.auth import SessionUser
from backend.csv_parsing import PositionsPayload
from backend.crypto_utils import decrypt_secret
from backend.deepseek_client import DeepSeekError, generate_narratives
from backend.supabase_client import (
    MarketPriceBar,
    PortfolioImportBatch,
    RiskAnalysisRecord,
    RiskNarrativesRecord,
    fetch_import_batch,
    fetch_latest_risk_analysis,
    fetch_risk_narratives,
    fetch_user_secret,
    insert_portfolio_import_batch,
    insert_risk_analysis,
    insert_risk_narratives,
    load_cached_market_price_bars,
    upsert_market_price_bars,
)

logger = logging.getLogger("wealthwise.risk")

RISK_LOOKBACK_DAYS = 252
RISK_TIMEFRAME = "1Day"
BENCHMARK_SYMBOL = "SPY"
SCENARIO_SHOCKS = [-0.1, -0.2, -0.3]


def _infer_market_value(row: Any) -> Optional[float]:
    if getattr(row, "market_value", None) is not None:
        try:
            return float(row.market_value)
        except Exception:
            return None
    qty = getattr(row, "quantity", None)
    price = getattr(row, "price", None)
    if qty is not None and price is not None:
        try:
            return float(qty * price)
        except Exception:
            return None
    return None


def _extract_positions(payload: PositionsPayload) -> List[Tuple[str, float]]:
    positions: List[Tuple[str, float]] = []
    for row in payload.rows:
        if (row.row_type or "").lower() != "position":
            continue
        symbol = (row.symbol or "").strip().upper()
        if not symbol:
            continue
        value = _infer_market_value(row)
        if value is None:
            continue
        positions.append((symbol, value))
    return positions


def _weights_from_positions(positions: List[Tuple[str, float]]) -> Dict[str, float]:
    totals: Dict[str, float] = {}
    for symbol, value in positions:
        totals[symbol] = totals.get(symbol, 0.0) + max(0.0, value)
    portfolio_value = sum(totals.values())
    if portfolio_value <= 0:
        return {}
    return {sym: val / portfolio_value for sym, val in totals.items() if val > 0}


def _hhi(weights: Dict[str, float]) -> float:
    return float(sum(w * w for w in weights.values()))


def _scenario_impacts(portfolio_value: float, weights: Dict[str, float]) -> Dict[str, Any]:
    impacts: Dict[str, Any] = {"portfolio_value": portfolio_value, "shocks": {}}
    for shock in SCENARIO_SHOCKS:
        impacts["shocks"][str(shock)] = {
            "portfolio_change": portfolio_value * shock,
            "holding_changes": {sym: weight * portfolio_value * shock for sym, weight in weights.items()},
        }
    return impacts


def _max_drawdown(returns: np.ndarray) -> Optional[float]:
    if returns.size == 0:
        return None
    cumulative = np.cumprod(1.0 + returns)
    peaks = np.maximum.accumulate(cumulative)
    drawdowns = cumulative / peaks - 1.0
    return float(drawdowns.min())


def _beta(portfolio_returns: np.ndarray, benchmark_returns: np.ndarray) -> Optional[float]:
    if portfolio_returns.size == 0 or benchmark_returns.size == 0:
        return None
    var_b = np.var(benchmark_returns)
    if var_b == 0:
        return None
    cov = np.cov(portfolio_returns, benchmark_returns)
    return float(cov[0, 1] / var_b)


def _align_returns(bars_by_symbol: Dict[str, List[MarketPriceBar]], symbols: List[str]):
    daily: Dict[str, Dict[datetime.date, float]] = {}
    for sym in symbols:
        bars = bars_by_symbol.get(sym)
        if not bars:
            return None, None
        daily[sym] = {bar.t.date(): float(bar.c) for bar in bars}
    intersect_dates = set.intersection(*(set(v.keys()) for v in daily.values()))
    dates = sorted(intersect_dates)
    if len(dates) < 2:
        return None, None
    returns: Dict[str, np.ndarray] = {}
    for sym in symbols:
        closes = np.array([daily[sym][d] for d in dates], dtype=float)
        returns[sym] = np.diff(closes) / closes[:-1]
    return dates[1:], returns


def _compute_market_metrics(
    bars_by_symbol: Dict[str, List[MarketPriceBar]], weights: Dict[str, float]
) -> Optional[Dict[str, Any]]:
    symbols = [s for s in weights.keys() if s != BENCHMARK_SYMBOL]
    if BENCHMARK_SYMBOL not in bars_by_symbol:
        return None
    if not symbols:
        return None

    aligned_symbols = symbols + [BENCHMARK_SYMBOL]
    dates, returns_by_symbol = _align_returns(bars_by_symbol, aligned_symbols)
    if returns_by_symbol is None or dates is None:
        return None

    # Limit weights to symbols that survived alignment
    symbols = [s for s in symbols if s in returns_by_symbol]
    if not symbols:
        return None

    returns_matrix = np.array([returns_by_symbol[s] for s in symbols], dtype=float)
    spy_returns = returns_by_symbol[BENCHMARK_SYMBOL]
    if returns_matrix.shape[1] != spy_returns.shape[0]:
        return None

    weights_vec = np.array([weights[s] for s in symbols], dtype=float)
    portfolio_returns = weights_vec.dot(returns_matrix)

    volatility = float(np.std(portfolio_returns) * np.sqrt(252)) if portfolio_returns.size else None
    max_dd = _max_drawdown(portfolio_returns)
    beta = _beta(portfolio_returns, spy_returns)

    avg_corr = None
    if len(symbols) > 1:
        corr = np.corrcoef(returns_matrix)
        upper = corr[np.triu_indices(len(symbols), k=1)]
        if upper.size:
            avg_corr = float(np.mean(upper))

    return {
        "lookback_days": RISK_LOOKBACK_DAYS,
        "benchmark": BENCHMARK_SYMBOL,
        "symbols_used": symbols,
        "coverage_days": len(dates),
        "volatility": volatility,
        "max_drawdown": max_dd,
        "beta": beta,
        "avg_correlation": avg_corr,
    }


def _merge_bars(
    cached: Dict[str, List[MarketPriceBar]], fresh: Dict[str, List[MarketPriceBar]]
) -> Dict[str, List[MarketPriceBar]]:
    merged: Dict[str, List[MarketPriceBar]] = {}
    symbols = set(cached.keys()) | set(fresh.keys())
    for sym in symbols:
        combined = (cached.get(sym) or []) + (fresh.get(sym) or [])
        # Deduplicate by timestamp
        seen = {}
        for bar in combined:
            seen[bar.t] = bar
        merged[sym] = sorted(seen.values(), key=lambda b: b.t)
    return merged


async def _ensure_market_data(
    symbols: List[str], start: datetime, end: datetime
) -> Dict[str, List[MarketPriceBar]]:
    cached = load_cached_market_price_bars(symbols, start, end, timeframe=RISK_TIMEFRAME)

    missing_symbols: List[str] = []
    for sym in symbols:
        bars = cached.get(sym)
        if not bars:
            missing_symbols.append(sym)
            continue
        last_bar = bars[-1].t
        if (end.date() - last_bar.date()).days > 5:
            missing_symbols.append(sym)
            continue
        if len(bars) < 120:
            missing_symbols.append(sym)

    fresh: Dict[str, List[MarketPriceBar]] = {}
    if missing_symbols:
        fresh = await fetch_daily_bars(missing_symbols, start, end, timeframe=RISK_TIMEFRAME)
        to_store = [bar for bars in fresh.values() for bar in bars]
        try:
            upsert_market_price_bars(to_store)
        except Exception as exc:  # pragma: no cover - best effort cache
            logger.warning("Failed to upsert market data cache: %s", exc)

    return _merge_bars(cached, fresh)


def _fallback_narratives(reason: str) -> List[Dict[str, Any]]:
    return [
        {
            "id": "fallback-1",
            "severity": "medium",
            "headline": "Risk analysis available",
            "summary": "Deterministic metrics were computed locally.",
            "why_it_matters": reason,
            "watch_thresholds": ["Provide a DeepSeek API key to enable narrative mode."],
        }
    ]


def import_holdings(
    user: SessionUser, payload: PositionsPayload, raw_csv: str, file_name: str
) -> PortfolioImportBatch:
    return insert_portfolio_import_batch(user, payload, raw_csv, file_name)


async def analyze_batch(
    user: SessionUser, batch_id: str, mode: str
) -> Tuple[RiskAnalysisRecord, List[Dict[str, Any]], Optional[str]]:
    batch = fetch_import_batch(user, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found.")

    positions = _extract_positions(batch.payload)
    weights = _weights_from_positions(positions)
    portfolio_value = sum(val for _, val in positions if val > 0)
    packet: Dict[str, Any] = {
        "mode": mode,
        "portfolio_value": portfolio_value,
        "weights": weights,
        "concentration": {
            "hhi": _hhi(weights) if weights else None,
            "top_positions": sorted(
                [{"symbol": sym, "weight": w} for sym, w in weights.items()],
                key=lambda x: x["weight"],
                reverse=True,
            )[:5],
        },
        "scenarios": _scenario_impacts(portfolio_value, weights),
    }

    market_data_status = "skipped"
    if mode == "enriched" and weights:
        symbols = list(weights.keys())
        if BENCHMARK_SYMBOL not in symbols:
            symbols.append(BENCHMARK_SYMBOL)

        end = datetime.now(timezone.utc)
        start = end - timedelta(days=int(RISK_LOOKBACK_DAYS * 1.6))
        try:
            bars_by_symbol = await _ensure_market_data(symbols, start, end)
            metrics = _compute_market_metrics(bars_by_symbol, weights)
            if metrics:
                packet["market_metrics"] = metrics
                market_data_status = "ok"
            else:
                market_data_status = "insufficient_data"
        except MarketDataError as exc:
            market_data_status = f"error: {exc}"
        except Exception as exc:  # pragma: no cover - defensive
            market_data_status = f"error: {exc}"
    packet["market_data_status"] = market_data_status

    analysis = RiskAnalysisRecord(
        id=str(uuid.uuid4()),
        user_sub=user["sub"],
        batch_id=batch_id,
        mode=mode,
        status="completed" if market_data_status in ("ok", "skipped", "insufficient_data") else "degraded",
        packet=packet,
        error=None if market_data_status in ("ok", "skipped", "insufficient_data") else market_data_status,
    )
    analysis = insert_risk_analysis(analysis)

    # DeepSeek narratives
    narratives: List[Dict[str, Any]] = []
    model_used: Optional[str] = None

    secret_record = fetch_user_secret(user["sub"], "deepseek")
    api_key = decrypt_secret(secret_record.encrypted_value) if secret_record else None
    if not api_key:
        api_key = os.getenv("DEEPSEEK_API_KEY") or None

    if api_key:
        try:
            narratives = await generate_narratives(packet, api_key=api_key)
            model_used = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        except DeepSeekError as exc:
            logger.warning("DeepSeek generation failed: %s", exc)
            narratives = _fallback_narratives("LLM narratives unavailable.")
            model_used = "template"
    else:
        narratives = _fallback_narratives("DeepSeek API key not configured.")
        model_used = "template"

    narratives_record = RiskNarrativesRecord(
        id=str(uuid.uuid4()),
        analysis_id=analysis.id,
        narratives=narratives,
        model=model_used,
    )
    insert_risk_narratives(narratives_record)

    return analysis, narratives, model_used


def latest_analysis(user: SessionUser, batch_id: Optional[str]) -> Optional[Dict[str, Any]]:
    record = fetch_latest_risk_analysis(user, batch_id)
    if not record:
        return None
    narratives = fetch_risk_narratives(record.id)
    return {
        "analysis": record.dict(),
        "narratives": narratives.narratives if narratives else [],
        "model": narratives.model if narratives else None,
    }
