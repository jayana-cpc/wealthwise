import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple

import numpy as np
from fastapi import HTTPException
from pydantic import BaseModel, Field

from backend.alpaca_client import MarketDataError
from backend.auth import SessionUser
from backend.performance_service import (
    DEFAULT_BENCHMARKS,
    PricePoint,
    _baseline_positions,
    _fallback_prices_from_positions,
    _fallback_prices_from_transactions,
    _load_market_bars,
    _parse_transactions_payload,
    _positions_timeline,
    _price_history_from_bars,
    _symbols_from_positions,
)
from backend.supabase_client import (
    PortfolioImportBatch,
    fetch_latest_import_batch,
    fetch_latest_transactions_upload,
)

logger = logging.getLogger("wealthwise.optimization")

# ---- Data models ----------------------------------------------------------------


class ConstraintInput(BaseModel):
    max_position_pct: Optional[float] = Field(
        default=None, description="Maximum weight for a single position (0-1 range)."
    )
    min_position_pct: Optional[float] = Field(
        default=None, description="Minimum weight threshold for a position (0-1 range)."
    )
    no_short: bool = Field(default=True, description="Disallow negative weights.")
    max_turnover: Optional[float] = Field(
        default=None,
        description="Maximum absolute turnover (sum |target-current|). Example 0.10 = 10%.",
    )
    rebalance_budget: Optional[float] = Field(
        default=None,
        description="Optional dollar budget for buys when rebalancing (sells still allowed).",
    )


class OptimizationRequest(BaseModel):
    method: str
    lookback: Literal["1Y", "3Y", "5Y", "MAX"] = "1Y"
    benchmark: str = "SPY"
    cov_model: Literal["sample", "shrinkage", "ewma"] = "shrinkage"
    return_model: Literal["historical_mean", "shrunk_mean", "momentum"] = "shrunk_mean"
    constraints: Optional[ConstraintInput] = None
    universe: Optional[List[str]] = Field(
        default=None, description="Optional override universe; defaults to current holdings."
    )


class OptimizationMethod(BaseModel):
    key: str
    goal: str
    label: str
    description: str
    tier: str
    uses_return_model: bool
    uses_covariance: bool


class AllocationWeights(BaseModel):
    recommended: Dict[str, float]
    current: Dict[str, float]
    equal_weight: Dict[str, float]


class TradeSuggestion(BaseModel):
    symbol: str
    action: Literal["buy", "sell", "hold"]
    shares: float
    notional: float


class PortfolioMetrics(BaseModel):
    total_return: Optional[float]
    cagr: Optional[float]
    volatility: Optional[float]
    max_drawdown: Optional[float]
    sharpe: Optional[float]
    tracking_error: Optional[float] = None


class BacktestPoint(BaseModel):
    date: str
    recommended: float
    current: float
    equal_weight: float
    benchmark: Optional[float] = None


class OptimizationResponse(BaseModel):
    method: str
    goal: str
    universe: List[str]
    lookback_days: int
    benchmark: str
    weights: AllocationWeights
    trades: List[TradeSuggestion]
    metrics: Dict[str, PortfolioMetrics]
    backtest: List[BacktestPoint]
    explain: Dict[str, Any]
    warnings: List[str]


AVAILABLE_METHODS: List[OptimizationMethod] = [
    OptimizationMethod(
        key="equal_weight",
        goal="Simplify",
        label="Equal Weight",
        description="Baseline: each holding carries the same weight.",
        tier="A",
        uses_return_model=False,
        uses_covariance=False,
    ),
    OptimizationMethod(
        key="inverse_vol",
        goal="Simplify",
        label="Inverse Volatility",
        description="Risk-balanced sizing proportional to 1/volatility.",
        tier="A",
        uses_return_model=False,
        uses_covariance=True,
    ),
    OptimizationMethod(
        key="gmv",
        goal="Lower volatility",
        label="Global Minimum Variance",
        description="Minimize total portfolio variance with long-only guardrails.",
        tier="A",
        uses_return_model=False,
        uses_covariance=True,
    ),
    OptimizationMethod(
        key="risk_parity",
        goal="Balanced risk",
        label="Equal Risk Contribution",
        description="Each holding contributes evenly to portfolio risk.",
        tier="A",
        uses_return_model=False,
        uses_covariance=True,
    ),
    OptimizationMethod(
        key="hrp",
        goal="Balanced risk",
        label="Hierarchical Risk Parity",
        description="Cluster-aware allocation that reduces concentration from unstable covariances.",
        tier="A",
        uses_return_model=False,
        uses_covariance=True,
    ),
    OptimizationMethod(
        key="max_diversification",
        goal="More diversified",
        label="Maximum Diversification",
        description="Maximize diversification ratio using vol + correlations only.",
        tier="A",
        uses_return_model=False,
        uses_covariance=True,
    ),
]


# ---- Helpers --------------------------------------------------------------------


def _parse_date(raw: str) -> datetime.date:
    return datetime.strptime(raw, "%Y-%m-%d").date()


def _lookback_window(end: date, lookback: str, earliest: Optional[date]) -> Tuple[date, date]:
    delta = {"1Y": 365, "3Y": 365 * 3, "5Y": 365 * 5, "MAX": 365 * 25}.get(lookback, 365)
    start = end - timedelta(days=delta)
    if earliest and start < earliest:
        start = earliest
    return start, end


def _project_simplex(weights: np.ndarray) -> np.ndarray:
    """Project weights to the simplex (sum=1, non-negative)."""
    if weights.size == 0:
        return weights
    w = np.maximum(weights, 0)
    total = w.sum()
    if total == 0:
        return np.ones_like(w) / len(w)
    return w / total


def _apply_weight_limits(weights: np.ndarray, min_w: Optional[float], max_w: Optional[float]) -> np.ndarray:
    w = np.array(weights, dtype=float)
    if max_w is not None:
        w = np.minimum(w, max_w)
    if min_w is not None:
        w = np.maximum(w, min_w)
    return _project_simplex(w)


def _enforce_turnover(target: np.ndarray, current: np.ndarray, max_turnover: Optional[float]) -> np.ndarray:
    if max_turnover is None:
        return target
    turnover = float(np.sum(np.abs(target - current)))
    if turnover <= max_turnover + 1e-8:
        return target
    blend = max_turnover / turnover if turnover > 0 else 0.0
    adjusted = current + (target - current) * blend
    return _project_simplex(adjusted)


def _max_drawdown(series: Sequence[float]) -> Optional[float]:
    if not series:
        return None
    peak = series[0]
    max_dd = 0.0
    for value in series:
        peak = max(peak, value)
        dd = (value - peak) / peak if peak else 0.0
        max_dd = min(max_dd, dd)
    return abs(max_dd)


def _returns_from_prices(prices: np.ndarray) -> np.ndarray:
    if prices.size < 2:
        return np.array([])
    prev = prices[:-1]
    curr = prices[1:]
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(prev > 0, curr / prev - 1.0, 0.0)


def _sample_cov(returns: np.ndarray) -> np.ndarray:
    if returns.shape[0] < 2:
        return np.eye(returns.shape[1])
    return np.cov(returns, rowvar=False)


def _shrinkage_cov(returns: np.ndarray) -> np.ndarray:
    """
    Lightweight Ledoit–Wolf style shrinkage toward the identity-scaled prior.
    """
    t, n = returns.shape
    if t < 2:
        return np.eye(n)
    X = returns - returns.mean(axis=0, keepdims=True)
    sample = np.cov(X, rowvar=False, bias=True)
    mu = np.trace(sample) / n
    prior = mu * np.eye(n)

    phi_mat = (X ** 2).T @ (X ** 2) / t - 2 * (X.T @ X) * sample / t + sample ** 2
    phi = phi_mat.sum()
    gamma = np.linalg.norm(sample - prior, ord="fro") ** 2
    kappa = phi / gamma if gamma > 0 else 0.0
    shrink = max(0.0, min(1.0, kappa / t))
    return shrink * prior + (1 - shrink) * sample


def _ewma_cov(returns: np.ndarray, decay: float = 0.94) -> np.ndarray:
    t, n = returns.shape
    if t < 2:
        return np.eye(n)
    weights = np.array([(1 - decay) * (decay ** i) for i in range(t - 1, -1, -1)], dtype=float)
    weights /= weights.sum()
    demeaned = returns - returns.mean(axis=0, keepdims=True)
    cov = (demeaned * weights[:, None]).T @ demeaned
    return cov


def _expected_returns(prices: np.ndarray, returns: np.ndarray, model: str) -> np.ndarray:
    if returns.size == 0:
        return np.zeros(prices.shape[1])
    daily_mean = returns.mean(axis=0)
    if model == "historical_mean":
        return daily_mean * 252.0
    if model == "shrunk_mean":
        return daily_mean * 252.0 * 0.5
    # Momentum: 12-1 month proxy; fallback to shorter windows when insufficient history.
    lookback = min(prices.shape[0] - 1, 252)
    if lookback <= 21:
        return daily_mean * 252.0
    start_idx = max(0, prices.shape[0] - lookback)
    end_idx = prices.shape[0] - 21
    window = prices[start_idx:end_idx]
    latest = prices[end_idx - 1]
    first = window[0]
    with np.errstate(divide="ignore", invalid="ignore"):
        momentum = np.where(first > 0, latest / first - 1.0, 0.0)
    return momentum


def _cluster_distance(cluster_a: List[int], cluster_b: List[int], dist: np.ndarray) -> float:
    values = [dist[i, j] for i in cluster_a for j in cluster_b if i != j]
    return float(np.mean(values)) if values else 0.0


def _hrp_order(cov: np.ndarray) -> List[int]:
    std = np.sqrt(np.maximum(np.diag(cov), 1e-12))
    denom = np.outer(std, std)
    corr = cov / denom
    np.fill_diagonal(corr, 1.0)
    dist = np.sqrt(0.5 * (1 - corr))

    @dataclass
    class Cluster:
        members: List[int]
        left: Optional["Cluster"] = None
        right: Optional["Cluster"] = None

    clusters: List[Cluster] = [Cluster([i]) for i in range(cov.shape[0])]
    while len(clusters) > 1:
        best_pair: Optional[Tuple[int, int]] = None
        best_dist = float("inf")
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                d = _cluster_distance(clusters[i].members, clusters[j].members, dist)
                if d < best_dist:
                    best_dist = d
                    best_pair = (i, j)
        if best_pair is None:
            break
        i, j = best_pair
        a, b = clusters[i], clusters[j]
        merged = Cluster(members=a.members + b.members, left=a, right=b)
        clusters = [c for idx, c in enumerate(clusters) if idx not in (i, j)]
        clusters.append(merged)

    root = clusters[0]

    def order(cluster: Cluster) -> List[int]:
        if cluster.left is None or cluster.right is None:
            return cluster.members
        return order(cluster.left) + order(cluster.right)

    return order(root)


def _hrp_weights(cov: np.ndarray) -> np.ndarray:
    order = _hrp_order(cov)
    cov_ord = cov[np.ix_(order, order)]
    w = np.ones(len(order))
    clusters = [list(range(len(order)))]

    def cluster_variance(indices: List[int]) -> float:
        sub = cov_ord[np.ix_(indices, indices)]
        ivp = 1.0 / np.diag(sub)
        ivp /= ivp.sum()
        return float(ivp.T @ sub @ ivp)

    while clusters:
        cluster = clusters.pop(0)
        if len(cluster) <= 1:
            continue
        split = len(cluster) // 2
        left = cluster[:split]
        right = cluster[split:]
        var_l = cluster_variance(left)
        var_r = cluster_variance(right)
        alloc_left = 1 - var_l / (var_l + var_r) if (var_l + var_r) > 0 else 0.5
        alloc_right = 1 - alloc_left
        w[left] *= alloc_left
        w[right] *= alloc_right
        clusters.append(left)
        clusters.append(right)

    raw = np.zeros_like(w)
    for idx, weight in zip(order, w):
        raw[idx] = weight
    return _project_simplex(raw)


def _inverse_vol_weights(cov: np.ndarray) -> np.ndarray:
    vol = np.sqrt(np.maximum(np.diag(cov), 1e-12))
    inv = 1.0 / vol
    return _project_simplex(inv)


def _gmv_weights(cov: np.ndarray) -> np.ndarray:
    n = cov.shape[0]
    eye = np.eye(n) * 1e-8
    inv = np.linalg.pinv(cov + eye)
    ones = np.ones(n)
    w = inv @ ones
    return _project_simplex(w)


def _risk_parity_weights(cov: np.ndarray) -> np.ndarray:
    n = cov.shape[0]
    w = np.ones(n) / n
    for _ in range(500):
        port_var = float(w.T @ cov @ w)
        mrc = cov @ w
        rc = w * mrc
        target = port_var / n
        gradient = rc - target
        if np.max(np.abs(gradient)) < 1e-6:
            break
        step = 0.05
        w = w - step * gradient / (mrc + 1e-12)
        w = np.maximum(w, 0)
        w = _project_simplex(w)
    return w


def _max_diversification_weights(cov: np.ndarray) -> np.ndarray:
    vol = np.sqrt(np.maximum(np.diag(cov), 1e-12))
    w = np.ones_like(vol) / len(vol)
    for _ in range(400):
        port_var = float(w.T @ cov @ w) + 1e-12
        port_vol = np.sqrt(port_var)
        ratio = float(vol @ w) / port_vol if port_vol > 0 else 0.0
        grad = (vol / port_vol) - (ratio / port_var) * (cov @ w)
        w = w + 0.1 * grad
        w = np.maximum(w, 0)
        w = _project_simplex(w)
    return w


def _optimize_weights(method: str, cov: np.ndarray) -> np.ndarray:
    if method == "equal_weight":
        return np.ones(cov.shape[0]) / cov.shape[0]
    if method == "inverse_vol":
        return _inverse_vol_weights(cov)
    if method == "gmv":
        return _gmv_weights(cov)
    if method == "risk_parity":
        return _risk_parity_weights(cov)
    if method == "hrp":
        return _hrp_weights(cov)
    if method == "max_diversification":
        return _max_diversification_weights(cov)
    raise HTTPException(status_code=400, detail=f"Unknown optimization method '{method}'.")


def _to_price_map(series: List[PricePoint]) -> Dict[date, float]:
    return {_parse_date(p.date): float(p.value) for p in series}


def _aligned_prices(
    price_history: Dict[str, List[PricePoint]],
    symbols: List[str],
    start: date,
    end: date,
    warnings: List[str],
) -> Tuple[List[date], np.ndarray, List[str]]:
    symbol_maps: Dict[str, Dict[date, float]] = {}
    usable: List[str] = []
    for sym in symbols:
        series = price_history.get(sym, [])
        filtered = [p for p in series if start <= _parse_date(p.date) <= end]
        if len(filtered) < 30:
            warnings.append(f"Insufficient price history for {sym}; dropped from optimization universe.")
            continue
        symbol_maps[sym] = _to_price_map(filtered)
        usable.append(sym)

    if not usable:
        raise HTTPException(status_code=400, detail="No symbols with usable price history.")

    common_dates = set.intersection(*(set(m.keys()) for m in symbol_maps.values()))
    if len(common_dates) < 30:
        warnings.append("Limited overlapping price history across symbols; results may be unstable.")
    dates = sorted(common_dates)
    if len(dates) < 5:
        raise HTTPException(status_code=400, detail="Not enough overlapping dates for optimization.")

    price_matrix = np.zeros((len(dates), len(usable)))
    for col, sym in enumerate(usable):
        m = symbol_maps[sym]
        price_matrix[:, col] = [m[d] for d in dates]

    return dates, price_matrix, usable


def _portfolio_value(shares: Dict[str, float], prices: Dict[str, float], cash: float) -> float:
    value = cash
    for sym, qty in shares.items():
        price = prices.get(sym)
        if price is not None:
            value += qty * price
    return value


def _weights_from_positions(shares: Dict[str, float], prices: Dict[str, float]) -> Dict[str, float]:
    totals: Dict[str, float] = {}
    for sym, qty in shares.items():
        price = prices.get(sym)
        if price is None or qty <= 0:
            continue
        totals[sym] = totals.get(sym, 0.0) + qty * price
    total_value = sum(totals.values())
    if total_value <= 0:
        return {}
    return {sym: val / total_value for sym, val in totals.items()}


def _compute_metrics(curve: List[float], dates: List[date], benchmark_curve: Optional[List[float]] = None) -> PortfolioMetrics:
    if not curve:
        return PortfolioMetrics(
            total_return=None,
            cagr=None,
            volatility=None,
            max_drawdown=None,
            sharpe=None,
            tracking_error=None,
        )
    start = curve[0]
    end = curve[-1]
    total_return = end / start - 1 if start > 0 else None
    days = max(1, (dates[-1] - dates[0]).days)
    cagr = (end / start) ** (365 / days) - 1 if start > 0 and days > 250 else None
    returns = _returns_from_prices(np.array(curve))
    volatility = float(np.std(returns) * np.sqrt(252)) if returns.size else None
    sharpe = (
        float(returns.mean() * 252 / (np.std(returns) + 1e-12))
        if returns.size and np.std(returns) > 0
        else None
    )
    max_dd = _max_drawdown(curve)

    tracking_error = None
    if benchmark_curve is not None and len(benchmark_curve) == len(curve):
        bench_returns = _returns_from_prices(np.array(benchmark_curve))
        aligned = min(len(returns), len(bench_returns))
        if aligned > 0:
            diff = returns[:aligned] - bench_returns[:aligned]
            tracking_error = float(np.std(diff) * np.sqrt(252))

    return PortfolioMetrics(
        total_return=total_return,
        cagr=cagr,
        volatility=volatility,
        max_drawdown=max_dd,
        sharpe=sharpe,
        tracking_error=tracking_error,
    )


def _backtest_curves(
    dates: List[date],
    prices: np.ndarray,
    weights_map: Dict[str, np.ndarray],
    benchmark_series: Optional[List[PricePoint]],
) -> Tuple[List[BacktestPoint], Dict[str, PortfolioMetrics]]:
    returns = _returns_from_prices(prices)
    if returns.ndim == 1:
        returns = returns.reshape(-1, 1)
    curves: Dict[str, List[float]] = {}
    metrics: Dict[str, PortfolioMetrics] = {}

    for name, weights in weights_map.items():
        port_returns = returns @ weights
        values = [1.0]
        for r in port_returns:
            values.append(values[-1] * (1.0 + float(r)))
        curves[name] = values

    bench_curve: Optional[List[float]] = None
    if benchmark_series:
        bench_map = {_parse_date(p.date): float(p.value) for p in benchmark_series}
        if all(d in bench_map for d in dates):
            bench_prices = np.array([bench_map[d] for d in dates])
            bench_returns = _returns_from_prices(bench_prices)
            values = [1.0]
            for r in bench_returns:
                values.append(values[-1] * (1.0 + float(r)))
            bench_curve = values
            metrics["benchmark"] = _compute_metrics(values, dates, None)

    series: List[BacktestPoint] = []
    for idx, d in enumerate(dates):
        series.append(
            BacktestPoint(
                date=d.isoformat(),
                recommended=curves["recommended"][idx],
                current=curves["current"][idx],
                equal_weight=curves["equal_weight"][idx],
                benchmark=bench_curve[idx] if bench_curve else None,
            )
        )

    for name, curve in curves.items():
        metrics[name] = _compute_metrics(curve, dates, bench_curve)

    return series, metrics


def _trade_suggestions(
    target: Dict[str, float],
    current: Dict[str, float],
    latest_prices: Dict[str, float],
    portfolio_value: float,
    cash: float,
    budget: Optional[float],
) -> List[TradeSuggestion]:
    total_capital = portfolio_value + max(0.0, cash)
    trades: List[TradeSuggestion] = []
    target_values: Dict[str, float] = {sym: wt * total_capital for sym, wt in target.items()}
    current_values: Dict[str, float] = {
        sym: current.get(sym, 0.0) * total_capital for sym in target.keys()
    }
    deltas: Dict[str, float] = {sym: target_values[sym] - current_values.get(sym, 0.0) for sym in target}

    buy_notional = sum(val for val in deltas.values() if val > 0)
    scale = 1.0
    if budget is not None and buy_notional > budget > 0:
        scale = budget / buy_notional

    for sym, delta_value in deltas.items():
        price = latest_prices.get(sym, 0.0)
        scaled_value = delta_value * scale
        shares_delta = scaled_value / price if price > 0 else 0.0
        action = "hold"
        if shares_delta > 1e-6:
            action = "buy"
        elif shares_delta < -1e-6:
            action = "sell"
        trades.append(
            TradeSuggestion(
                symbol=sym,
                action=action,
                shares=float(shares_delta),
                notional=float(scaled_value),
            )
        )
    return trades


# ---- Public API -----------------------------------------------------------------


def list_methods() -> Dict[str, Any]:
    return {"methods": [m.dict() for m in AVAILABLE_METHODS]}


async def run_optimization(user: SessionUser, body: OptimizationRequest) -> OptimizationResponse:
    batch: Optional[PortfolioImportBatch] = fetch_latest_import_batch(user)
    if not batch:
        raise HTTPException(status_code=404, detail="No holdings upload found. Upload a CSV first.")

    tx_upload = fetch_latest_transactions_upload(user)
    if not tx_upload:
        raise HTTPException(
            status_code=404,
            detail="No transactions upload found. Upload a transactions JSON file first.",
        )

    txns = _parse_transactions_payload(tx_upload.payload)
    holdings_symbols = _symbols_from_positions(batch.payload)
    txn_symbols = [t.symbol for t in txns if t.symbol]
    symbols = sorted(set(body.universe or holdings_symbols or txn_symbols))
    if not symbols:
        raise HTTPException(status_code=400, detail="No symbols detected in holdings or transactions.")

    target_cash = Decimal("0")
    shares_decimal: Dict[str, Decimal] = {}
    for row in batch.payload.rows:
        if row.row_type == "cash" and row.market_value is not None:
            try:
                target_cash = Decimal(str(row.market_value))
            except Exception:
                target_cash = Decimal("0")
        if row.row_type == "position" and row.symbol and row.quantity is not None:
            try:
                shares_decimal[row.symbol.strip().upper()] = Decimal(str(row.quantity))
            except Exception:
                continue

    # Build timeline to infer cash from transactions and align coverage window.
    all_dates = [t.date for t in txns]
    start_date_txn = min(all_dates) - timedelta(days=1)
    end_date_txn = max(all_dates)
    now_cutoff = datetime.now(timezone.utc) - timedelta(minutes=20)
    if end_date_txn > now_cutoff.date():
        end_date_txn = now_cutoff.date()

    baseline_shares, initial_cash, _ = _baseline_positions(
        txns, shares_decimal, target_cash
    )
    positions = _positions_timeline(txns, baseline_shares, initial_cash, start_date_txn, end_date_txn)
    cash_balance = positions[-1].cash if positions else target_cash
    end_date = end_date_txn
    start_date, end_date = _lookback_window(end_date, body.lookback, start_date_txn)

    warnings: List[str] = []
    start_dt = datetime.combine(start_date, time.min, tzinfo=timezone.utc)
    end_dt = datetime.combine(end_date, time(hour=23, minute=40), tzinfo=timezone.utc)

    bars_by_symbol: Dict[str, List] = {}
    fetch_symbols = symbols + [body.benchmark] if body.benchmark not in symbols else symbols
    if body.benchmark not in DEFAULT_BENCHMARKS:
        warnings.append(f"Benchmark {body.benchmark} not in defaults ({', '.join(DEFAULT_BENCHMARKS)}).")

    try:
        bars_by_symbol = await _load_market_bars(fetch_symbols, start_dt, end_dt, warnings)
    except MarketDataError as exc:
        warnings.append(f"Alpaca market data error: {exc}. Falling back to static prices.")
    except Exception as exc:  # pragma: no cover - defensive
        warnings.append(f"Market data unavailable: {exc}. Using static prices.")

    fallback_prices = _fallback_prices_from_positions(batch.payload)
    txn_prices = _fallback_prices_from_transactions(txns)
    fallback_prices.update({k: v for k, v in txn_prices.items() if k not in fallback_prices})
    for bmk in DEFAULT_BENCHMARKS:
        fallback_prices.setdefault(bmk, 100.0)

    price_history = _price_history_from_bars(bars_by_symbol, fallback_prices, start_date, end_date, warnings)
    dates, price_matrix, usable_symbols = _aligned_prices(price_history, symbols, start_date, end_date, warnings)

    if len(usable_symbols) < len(symbols):
        symbols = usable_symbols

    latest_prices: Dict[str, float] = {}
    for sym in symbols:
        series = price_history.get(sym, [])
        if series:
            latest_prices[sym] = float(series[-1].value)

    returns_matrix = _returns_from_prices(price_matrix)
    if returns_matrix.ndim == 1:
        returns_matrix = returns_matrix.reshape(-1, 1)

    if returns_matrix.shape[0] < 2:
        raise HTTPException(status_code=400, detail="Not enough return observations for optimization.")

    expected_ret = _expected_returns(price_matrix, returns_matrix, body.return_model)

    if body.cov_model == "sample":
        cov = _sample_cov(returns_matrix)
    elif body.cov_model == "ewma":
        cov = _ewma_cov(returns_matrix)
    else:
        cov = _shrinkage_cov(returns_matrix)

    target_weights = _optimize_weights(body.method, cov)
    target_weights = _apply_weight_limits(
        target_weights,
        body.constraints.min_position_pct if body.constraints else None,
        body.constraints.max_position_pct if body.constraints else None,
    )

    shares_float = {sym: float(qty) for sym, qty in shares_decimal.items()}
    current_w_map = _weights_from_positions(shares_float, latest_prices)
    current_weights_vec = np.array([current_w_map.get(sym, 0.0) for sym in symbols], dtype=float)
    if current_weights_vec.sum() <= 0:
        current_weights_vec = np.ones(len(symbols)) / len(symbols)

    if body.constraints and body.constraints.max_turnover is not None:
        target_weights = _enforce_turnover(target_weights, current_weights_vec, body.constraints.max_turnover)

    equal_weights_vec = np.ones(len(symbols)) / len(symbols)

    portfolio_value = _portfolio_value(shares_float, latest_prices, cash_balance)
    target = {sym: float(w) for sym, w in zip(symbols, target_weights)}
    current_w = {sym: float(w) for sym, w in zip(symbols, current_weights_vec)}
    equal_w = {sym: float(w) for sym, w in zip(symbols, equal_weights_vec)}

    trades = _trade_suggestions(
        target=target,
        current=current_w,
        latest_prices=latest_prices,
        portfolio_value=portfolio_value,
        cash=cash_balance,
        budget=body.constraints.rebalance_budget if body.constraints else None,
    )

    # Backtest series for recommended/current/equal-weight
    weights_map = {
        "recommended": target_weights,
        "current": current_weights_vec,
        "equal_weight": equal_weights_vec,
    }
    benchmark_series = price_history.get(body.benchmark)
    if not benchmark_series:
        warnings.append(f"No price history for benchmark {body.benchmark}; overlay omitted.")
    backtest_series, metrics = _backtest_curves(dates, price_matrix, weights_map, benchmark_series)

    explain = {
        "covariance_model": body.cov_model,
        "return_model": body.return_model,
        "expected_returns_annualized": {sym: float(val) for sym, val in zip(symbols, expected_ret)},
        "constraints": body.constraints.dict() if body.constraints else {},
        "notes": [
            "Long-only weights projected to simplex (sum=1); shorting is currently disabled.",
            "Turnover constraint blends toward current weights when specified.",
            "Buy notional is capped by rebalance_budget when provided.",
        ],
    }

    response = OptimizationResponse(
        method=body.method,
        goal=next((m.goal for m in AVAILABLE_METHODS if m.key == body.method), "Custom"),
        universe=symbols,
        lookback_days=(dates[-1] - dates[0]).days,
        benchmark=body.benchmark,
        weights=AllocationWeights(
          recommended=target,
          current=current_w,
          equal_weight=equal_w,
        ),
        trades=trades,
        metrics=metrics,
        backtest=backtest_series,
        explain=explain,
        warnings=warnings,
    )
    return response
