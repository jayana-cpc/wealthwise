"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type User = {
  email?: string;
  name?: string;
  picture?: string;
};

type PricePoint = { date: string; value: number };
type PortfolioPoint = PricePoint & { equity: number; cash: number };
type PositionState = { date: string; shares: Record<string, number>; cash: number };
type HoldingSummary = {
  symbol: string;
  description: string;
  shares: number;
  current_value: number;
  cost_basis?: number | null;
  gain_abs?: number | null;
  gain_pct?: number | null;
};

type PerformanceResponse = {
  start_date: string;
  end_date: string;
  symbols: string[];
  benchmarks: string[];
  portfolio: PortfolioPoint[];
  benchmark_series: Record<string, PricePoint[]>;
  price_series: Record<string, PricePoint[]>;
  positions: PositionState[];
  holdings: HoldingSummary[];
  warnings: string[];
};

type RangeKey = "1W" | "1M" | "3M" | "1Y" | "MAX";

type Metrics = {
  totalReturn: number | null;
  totalAbs: number | null;
  annualized: number | null;
  volatility: number | null;
  maxDrawdown: number | null;
  sharpe: number | null;
  beta: number | null;
  correlation: number | null;
};

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "1W", label: "1W" },
  { key: "1M", label: "1M" },
  { key: "3M", label: "3M" },
  { key: "1Y", label: "1Y" },
  { key: "MAX", label: "Max" },
];

const BENCHMARKS = ["SPY", "IWM"];

export default function PerformancePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [authStatus, setAuthStatus] = useState<"checking" | "ready" | "error">("checking");

  const [dataStatus, setDataStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );
  const [dataError, setDataError] = useState<string | null>(null);
  const [payload, setPayload] = useState<PerformanceResponse | null>(null);

  const [selectedRange, setSelectedRange] = useState<RangeKey>("1Y");
  const [viewMode, setViewMode] = useState<"value" | "indexed">("indexed");
  const [selectedBenchmarks, setSelectedBenchmarks] = useState<string[]>(["SPY", "IWM"]);
  const [overlaySymbols, setOverlaySymbols] = useState<string[]>([]);

  const BACKEND_BASE_URL = useMemo(
    () => process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001",
    []
  );

  useEffect(() => {
    const verifySession = async () => {
      try {
        const res = await fetch(`${BACKEND_BASE_URL}/me`, {
          method: "GET",
          credentials: "include",
        });
        if (!res.ok) {
          router.replace("/signin");
          return;
        }
        const data = (await res.json()) as User;
        setUser(data);
        setAuthStatus("ready");
      } catch {
        setAuthStatus("error");
      }
    };

    verifySession();
  }, [BACKEND_BASE_URL, router]);

  useEffect(() => {
    const loadPerformance = async () => {
      setDataStatus("loading");
      setDataError(null);
      try {
        const res = await fetch(`${BACKEND_BASE_URL}/api/performance/portfolio`, {
          credentials: "include",
        });
        if (res.status === 401) {
          router.replace("/signin");
          return;
        }
        if (!res.ok) {
          const errorBody = await res.json().catch(() => null);
          const detail =
            errorBody?.detail ||
            (typeof errorBody === "string" ? errorBody : "Unable to load performance data.");
          throw new Error(detail);
        }
        const data = (await res.json()) as PerformanceResponse;
        setPayload(data);
        setDataStatus("ready");
      } catch (err) {
        setDataStatus("error");
        setDataError(
          err instanceof Error ? err.message : "Unable to load performance data. Try again."
        );
      }
    };

    if (authStatus === "ready") {
      loadPerformance();
    }
  }, [BACKEND_BASE_URL, authStatus, router]);

  const rangeBounds = useMemo(() => {
    if (!payload) return null;
    const endDate = parseDate(payload.end_date);
    const minDate = parseDate(payload.start_date);
    const startDate =
      selectedRange === "MAX"
        ? minDate
        : subtractRange(endDate, selectedRange, minDate);
    return { startDate, endDate };
  }, [payload, selectedRange]);

  const filteredPortfolio = useMemo(() => {
    if (!payload || !rangeBounds) return [];
    return filterSeries(payload.portfolio, rangeBounds.startDate, rangeBounds.endDate);
  }, [payload, rangeBounds]);

  const filteredBenchmarks = useMemo(() => {
    if (!payload || !rangeBounds) return {};
    const out: Record<string, PricePoint[]> = {};
    for (const b of selectedBenchmarks) {
      const series = payload.benchmark_series[b];
      if (series) {
        out[b] = filterSeries(series, rangeBounds.startDate, rangeBounds.endDate);
      }
    }
    return out;
  }, [payload, rangeBounds, selectedBenchmarks]);

  const overlaySeries = useMemo(() => {
    if (!payload || !rangeBounds) return {};
    const out: Record<string, PricePoint[]> = {};
    overlaySymbols.forEach((sym) => {
      const series = payload.price_series[sym];
      if (series) {
        out[sym] = filterSeries(series, rangeBounds.startDate, rangeBounds.endDate);
      }
    });
    return out;
  }, [overlaySymbols, payload, rangeBounds]);

  const metrics = useMemo(() => {
    if (!filteredPortfolio.length) return emptyMetrics();
    const portfolioMetrics = computeMetrics(filteredPortfolio);
    const benchmarkKey = selectedBenchmarks[0];
    const benchmarkSeries = benchmarkKey ? filteredBenchmarks[benchmarkKey] : undefined;
    const benchmarkMetrics = benchmarkSeries ? computeRelativeMetrics(filteredPortfolio, benchmarkSeries) : {};
    return { ...portfolioMetrics, ...benchmarkMetrics };
  }, [filteredBenchmarks, filteredPortfolio, selectedBenchmarks]);

  const holdingsView = useMemo(() => {
    if (!payload || !rangeBounds) return [];
    return computeHoldingPerformance(payload, rangeBounds.startDate, rangeBounds.endDate);
  }, [payload, rangeBounds]);

  const chartData = useMemo(() => {
    if (!payload || !rangeBounds) return [];
    return buildChartData({
      portfolio: filteredPortfolio,
      benchmarks: filteredBenchmarks,
      overlays: overlaySeries,
      viewMode,
    });
  }, [filteredBenchmarks, filteredPortfolio, overlaySeries, rangeBounds, payload, viewMode]);

  const latestValue = filteredPortfolio.at(-1)?.value ?? null;

  const toggleOverlay = (symbol: string) => {
    setOverlaySymbols((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]
    );
  };

  return (
    <main className="min-h-screen bg-linear-to-br from-[#050712] via-[#0a0f21] to-[#0f1a3d] text-white">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-blue-100/70">
              Portfolio performance
            </p>
            <h1 className="mt-1 text-3xl font-semibold text-white">
              Rebuild value from transactions
            </h1>
            <p className="mt-1 text-sm text-blue-100/80">
              Uses your positions CSV, transaction history, and Alpaca daily bars to plot portfolio, benchmarks, and per-holding gains.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/dashboard"
              className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:border-white/40 hover:bg-white/10"
            >
              Back to dashboard
            </Link>
          </div>
        </header>

        {authStatus === "checking" && (
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-blue-100 shadow-lg shadow-indigo-900/30">
            Verifying your session...
          </div>
        )}

        {authStatus === "error" && (
          <div className="mt-6 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-6 text-rose-100 shadow-lg shadow-rose-900/30">
            We could not verify your session. Please return to the homepage and sign in again.
          </div>
        )}

        {authStatus === "ready" && (
          <div className="mt-6 space-y-6">
            {user && (
              <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 shadow-lg shadow-indigo-900/30">
                {user.picture && (
                  <img
                    src={user.picture}
                    alt={user.name ?? "User avatar"}
                    className="h-9 w-9 rounded-full object-cover"
                  />
                )}
                <div>
                  <p className="text-sm font-semibold text-white">
                    {user.name ?? "Signed in"}
                  </p>
                  <p className="text-xs text-blue-100/70">{user.email}</p>
                </div>
                <span className="ml-auto rounded-full bg-emerald-500/15 px-3 py-1 text-[10px] font-semibold uppercase text-emerald-200">
                  Active session
                </span>
              </div>
            )}

            {dataStatus === "loading" && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-blue-100 shadow-lg shadow-indigo-900/30">
                Loading performance data...
              </div>
            )}

            {dataStatus === "error" && (
              <div className="rounded-2xl border border-rose-400/40 bg-rose-500/10 p-6 text-rose-100 shadow-lg shadow-rose-900/30">
                {dataError ?? "Could not load performance data."}
              </div>
            )}

            {dataStatus === "ready" && payload && (
              <div className="space-y-5">
                {payload.warnings.length > 0 && (
                  <div className="rounded-2xl border border-amber-300/30 bg-amber-500/10 p-4 text-sm text-amber-50 shadow-lg shadow-amber-900/30">
                    <p className="font-semibold text-white">Data warnings</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-50/90">
                      {payload.warnings.map((w, idx) => (
                        <li key={idx}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <MetricCard
                    label="Portfolio value"
                    value={latestValue != null ? formatCurrency(latestValue) : "-"}
                    sub={`As of ${payload.end_date}`}
                  />
                  <MetricCard
                    label="Total return"
                    value={metrics.totalReturn != null ? formatPercent(metrics.totalReturn) : "—"}
                    sub={metrics.totalAbs != null ? formatCurrency(metrics.totalAbs) : undefined}
                  />
                  <MetricCard
                    label="Max drawdown"
                    value={metrics.maxDrawdown != null ? formatPercent(metrics.maxDrawdown) : "—"}
                    sub={metrics.volatility != null ? `Vol ${formatPercent(metrics.volatility)}` : undefined}
                  />
                </section>

                <section className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-blue-100/70">
                        Portfolio vs benchmarks
                      </p>
                      <p className="text-sm text-blue-100/80">
                        Time-aligned series from reconstructed positions and Alpaca 1D bars.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex flex-wrap gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-1">
                        {RANGE_OPTIONS.map((opt) => (
                          <button
                            key={opt.key}
                            onClick={() => setSelectedRange(opt.key)}
                            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                              selectedRange === opt.key
                                ? "bg-white/80 text-indigo-900"
                                : "text-blue-100 hover:bg-white/10"
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold">
                        <button
                          onClick={() => setViewMode("value")}
                          className={`rounded-full px-3 py-1 transition ${
                            viewMode === "value"
                              ? "bg-white/80 text-indigo-900"
                              : "text-blue-100 hover:bg-white/10"
                          }`}
                        >
                          $ value
                        </button>
                        <button
                          onClick={() => setViewMode("indexed")}
                          className={`rounded-full px-3 py-1 transition ${
                            viewMode === "indexed"
                              ? "bg-white/80 text-indigo-900"
                              : "text-blue-100 hover:bg-white/10"
                          }`}
                        >
                          Indexed %
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2 text-xs text-blue-100/80">
                    {BENCHMARKS.map((bmk) => (
                      <button
                        key={bmk}
                        onClick={() =>
                          setSelectedBenchmarks((prev) =>
                            prev.includes(bmk)
                              ? prev.filter((b) => b !== bmk)
                              : [...prev, bmk]
                          )
                        }
                        className={`rounded-full border px-3 py-1 font-semibold transition ${
                          selectedBenchmarks.includes(bmk)
                            ? "border-indigo-400/70 bg-indigo-500/20 text-white"
                            : "border-white/20 bg-white/5 text-blue-100 hover:border-white/35 hover:bg-white/10"
                        }`}
                      >
                        {bmk}
                      </button>
                    ))}
                    <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 font-medium text-blue-100">
                      Overlays: {overlaySymbols.length ? overlaySymbols.join(", ") : "none"}
                    </span>
                  </div>

                  <div className="mt-5 h-80 w-full rounded-xl border border-white/10 bg-black/20 p-3">
                    {chartData.length > 1 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ left: 8, right: 8, top: 8 }}>
                          <CartesianGrid stroke="#243056" strokeDasharray="3 3" opacity={0.4} />
                          <XAxis
                            dataKey="date"
                            tick={{ fill: "#cdd7ff", fontSize: 11 }}
                            tickMargin={6}
                          />
                          <YAxis
                            tick={{ fill: "#cdd7ff", fontSize: 11 }}
                            tickFormatter={(v) => (viewMode === "indexed" ? `${v.toFixed(0)}%` : `$${(v / 1000).toFixed(0)}k`)}
                            width={70}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "rgba(11,16,32,0.9)",
                              border: "1px solid rgba(255,255,255,0.12)",
                              borderRadius: "12px",
                              color: "#fff",
                            }}
                            formatter={(value: number, name: string) =>
                              viewMode === "indexed"
                                ? [`${value.toFixed(2)}%`, name]
                                : [formatCurrency(value), name]
                            }
                          />
                          <Legend />
                          <Line
                            type="monotone"
                            dataKey="Portfolio"
                            stroke="#a5b4ff"
                            strokeWidth={2.6}
                            dot={false}
                            activeDot={{ r: 4 }}
                          />
                          {Object.keys(filteredBenchmarks).map((bmk) => (
                            <Line
                              key={bmk}
                              type="monotone"
                              dataKey={bmk}
                              stroke={bmk === "SPY" ? "#34d399" : "#f59e0b"}
                              strokeWidth={1.8}
                              dot={false}
                            />
                          ))}
                          {Object.keys(overlaySeries).map((sym, idx) => (
                            <Line
                              key={sym}
                              type="monotone"
                              dataKey={`Overlay-${sym}`}
                              stroke={overlayColor(idx)}
                              strokeDasharray="4 2"
                              strokeWidth={1.4}
                              dot={false}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-blue-100/80">
                        Not enough data to render chart.
                      </div>
                    )}
                  </div>
                </section>

                <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <MetricCard
                    label="Annualized return"
                    value={metrics.annualized != null ? formatPercent(metrics.annualized) : "—"}
                    sub={metrics.sharpe != null ? `Sharpe-like ${metrics.sharpe.toFixed(2)}` : undefined}
                  />
                  <MetricCard
                    label="Correlation vs benchmark"
                    value={
                      metrics.correlation != null ? metrics.correlation.toFixed(2) : "—"
                    }
                    sub={metrics.beta != null ? `Beta ${metrics.beta.toFixed(2)}` : undefined}
                  />
                  <MetricCard
                    label="Cash balance"
                    value={
                      payload.positions.length
                        ? formatCurrency(payload.positions[payload.positions.length - 1].cash)
                        : "-"
                    }
                    sub="Latest reconstructed cash"
                  />
                </section>

                <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="lg:col-span-2">
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                            Holdings overlays
                          </p>
                          <p className="text-sm text-blue-100/80">
                            Tap to add/remove a symbol line on the chart (indexed view recommended).
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {payload.holdings.map((h) => (
                          <button
                            key={h.symbol}
                            onClick={() => toggleOverlay(h.symbol)}
                            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                              overlaySymbols.includes(h.symbol)
                                ? "border-emerald-400/60 bg-emerald-500/15 text-white"
                                : "border-white/20 bg-white/5 text-blue-100 hover:border-white/35 hover:bg-white/10"
                            }`}
                          >
                            {h.symbol}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                          Window metrics
                        </p>
                        <p className="text-sm text-blue-100/80">
                          Metrics recomputed for the selected range only.
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2 text-sm text-blue-100/85">
                      <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                        <span>Total return</span>
                        <span className="font-semibold text-white">
                          {metrics.totalReturn != null ? formatPercent(metrics.totalReturn) : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                        <span>Volatility (ann.)</span>
                        <span className="font-semibold text-white">
                          {metrics.volatility != null ? formatPercent(metrics.volatility) : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                        <span>Max drawdown</span>
                        <span className="font-semibold text-white">
                          {metrics.maxDrawdown != null ? formatPercent(metrics.maxDrawdown) : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-indigo-900/30">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                        Holdings performance
                      </p>
                      <p className="text-sm text-blue-100/80">
                        Gains and values recalculated for the selected window ({selectedRange}).
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 overflow-auto rounded-xl border border-white/10 bg-black/20 shadow-lg shadow-indigo-900/30">
                    <table className="min-w-full border-collapse text-sm">
                      <thead className="bg-white/10 text-left text-xs uppercase tracking-wide text-blue-100/70">
                        <tr>
                          <th className="px-3 py-3">Symbol</th>
                          <th className="px-3 py-3">Description</th>
                          <th className="px-3 py-3 text-right">Shares</th>
                          <th className="px-3 py-3 text-right">Value</th>
                          <th className="px-3 py-3 text-right">Gain $</th>
                          <th className="px-3 py-3 text-right">Gain %</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {holdingsView.map((h) => (
                          <tr key={h.symbol} className="hover:bg-white/5">
                            <td className="px-3 py-3 font-semibold text-white">{h.symbol}</td>
                            <td className="px-3 py-3 text-blue-100/80">{h.description || "—"}</td>
                            <td className="px-3 py-3 text-right text-blue-100/80 tabular-nums">
                              {h.shares.toFixed(2)}
                            </td>
                            <td className="px-3 py-3 text-right text-blue-100/80 tabular-nums">
                              {formatCurrency(h.current_value)}
                            </td>
                            <td className="px-3 py-3 text-right text-blue-100/80 tabular-nums">
                              {h.gain_abs != null ? formatCurrency(h.gain_abs) : "—"}
                            </td>
                            <td className="px-3 py-3 text-right text-blue-100/80 tabular-nums">
                              {h.gain_pct != null ? formatPercent(h.gain_pct) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function parseDate(raw: string): Date {
  return new Date(`${raw}T00:00:00Z`);
}

function subtractRange(end: Date, range: RangeKey, minDate: Date): Date {
  const d = new Date(end.getTime());
  const delta =
    range === "1W" ? 7 : range === "1M" ? 30 : range === "3M" ? 90 : range === "1Y" ? 365 : 0;
  if (delta > 0) {
    d.setDate(d.getDate() - delta);
  }
  return d < minDate ? minDate : d;
}

function filterSeries<T extends { date: string }>(series: T[], start: Date, end: Date): T[] {
  return series.filter((p) => {
    const d = parseDate(p.date);
    return d >= start && d <= end;
  });
}

function formatCurrency(value: number): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(value) >= 100000 ? 0 : 2,
  });
  return formatter.format(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function stdDev(values: number[]): number {
  if (!values.length) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

function computeMetrics(series: PortfolioPoint[]): Metrics {
  if (series.length < 2) return emptyMetrics();
  const start = series[0];
  const end = series[series.length - 1];
  const days =
    (parseDate(end.date).getTime() - parseDate(start.date).getTime()) / (1000 * 60 * 60 * 24);

  const totalReturn = start.value > 0 ? end.value / start.value - 1 : null;
  const totalAbs = end.value - start.value;

  const returns: number[] = [];
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1].value;
    const curr = series[i].value;
    if (prev > 0) returns.push(curr / prev - 1);
  }

  const volatility = returns.length ? stdDev(returns) * Math.sqrt(252) : null;
  const avgDaily = returns.length
    ? returns.reduce((sum, r) => sum + r, 0) / returns.length
    : null;
  const sharpe =
    avgDaily != null && volatility && volatility > 0 ? (avgDaily * 252) / volatility : null;
  const annualized =
    totalReturn != null && days >= 30 ? Math.pow(1 + totalReturn, 365 / days) - 1 : null;

  const maxDrawdown = computeMaxDrawdown(series.map((p) => p.value));

  return {
    totalReturn,
    totalAbs,
    annualized,
    volatility,
    maxDrawdown,
    sharpe,
    beta: null,
    correlation: null,
  };
}

function computeRelativeMetrics(
  portfolio: PortfolioPoint[],
  benchmark: PricePoint[]
): Partial<Metrics> {
  const benchMap: Record<string, number> = {};
  benchmark.forEach((b) => {
    benchMap[b.date] = b.value;
  });

  const portReturns: number[] = [];
  const benchReturns: number[] = [];
  for (let i = 1; i < portfolio.length; i += 1) {
    const date = portfolio[i].date;
    const prevDate = portfolio[i - 1].date;
    const benchVal = benchMap[date];
    const benchPrev = benchMap[prevDate];
    if (benchVal == null || benchPrev == null) continue;
    const portPrev = portfolio[i - 1].value;
    const portCurr = portfolio[i].value;
    if (portPrev <= 0 || benchPrev <= 0) continue;
    portReturns.push(portCurr / portPrev - 1);
    benchReturns.push(benchVal / benchPrev - 1);
  }
  if (!portReturns.length || portReturns.length !== benchReturns.length) {
    return { beta: null, correlation: null };
  }
  const corr = correlation(portReturns, benchReturns);
  const beta = betaCalc(portReturns, benchReturns);
  return { beta, correlation: corr };
}

function correlation(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  const denom = Math.sqrt(denomA * denomB);
  if (denom === 0) return null;
  return numerator / denom;
}

function betaCalc(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < a.length; i += 1) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varB += (b[i] - meanB) * (b[i] - meanB);
  }
  if (varB === 0) return null;
  return cov / varB;
}

function computeMaxDrawdown(values: number[]): number | null {
  if (!values.length) return null;
  let maxPeak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > maxPeak) maxPeak = v;
    const dd = (v - maxPeak) / maxPeak;
    if (dd < maxDD) maxDD = dd;
  }
  return Math.abs(maxDD);
}

function emptyMetrics(): Metrics {
  return {
    totalReturn: null,
    totalAbs: null,
    annualized: null,
    volatility: null,
    maxDrawdown: null,
    sharpe: null,
    beta: null,
    correlation: null,
  };
}

function buildChartData({
  portfolio,
  benchmarks,
  overlays,
  viewMode,
}: {
  portfolio: PortfolioPoint[];
  benchmarks: Record<string, PricePoint[]>;
  overlays: Record<string, PricePoint[]>;
  viewMode: "value" | "indexed";
}) {
  if (!portfolio.length) return [];
  const baseStart = portfolio[0].value || 1;
  const benchmarkStarts: Record<string, number> = {};
  Object.entries(benchmarks).forEach(([key, series]) => {
    benchmarkStarts[key] = series[0]?.value ?? 1;
  });
  const overlayStarts: Record<string, number> = {};
  Object.entries(overlays).forEach(([key, series]) => {
    overlayStarts[key] = series[0]?.value ?? 1;
  });

  const benchLookup: Record<string, PricePoint[]> = {};
  Object.entries(benchmarks).forEach(([k, series]) => {
    benchLookup[k] = series;
  });
  const overlayLookup: Record<string, PricePoint[]> = {};
  Object.entries(overlays).forEach(([k, series]) => {
    overlayLookup[k] = series;
  });

  const lookupValue = (series: PricePoint[] | undefined, target: string) => {
    if (!series) return null;
    let price: number | null = null;
    for (const point of series) {
      if (point.date <= target) {
        price = point.value;
      } else {
        break;
      }
    }
    return price;
  };

  return portfolio.map((p) => {
    const row: Record<string, number | string> = { date: p.date };
    row.Portfolio = viewMode === "indexed" ? ((p.value / baseStart - 1) * 100) : p.value;

    Object.keys(benchLookup).forEach((key) => {
      const series = benchLookup[key];
      const val = lookupValue(series, p.date);
      const start = benchmarkStarts[key] || 1;
      if (val != null) {
        row[key] = viewMode === "indexed" ? ((val / start - 1) * 100) : val;
      }
    });

    Object.keys(overlayLookup).forEach((key) => {
      const series = overlayLookup[key];
      const val = lookupValue(series, p.date);
      const start = overlayStarts[key] || 1;
      if (val != null) {
        row[`Overlay-${key}`] =
          viewMode === "indexed" ? ((val / start - 1) * 100) : val;
      }
    });
    return row;
  });
}

function overlayColor(idx: number): string {
  const palette = ["#7dd3fc", "#f472b6", "#a78bfa", "#f97316", "#22d3ee", "#34d399"];
  return palette[idx % palette.length];
}

function findPositionAt(
  positions: PositionState[],
  target: Date
): PositionState | null {
  let current: PositionState | null = null;
  for (const pos of positions) {
    const posDate = parseDate(pos.date);
    if (posDate <= target) {
      current = pos;
    } else {
      break;
    }
  }
  return current;
}

function priceAt(series: PricePoint[] | undefined, target: Date): number | null {
  if (!series || !series.length) return null;
  let price: number | null = null;
  for (const point of series) {
    const d = parseDate(point.date);
    if (d <= target) {
      price = point.value;
    } else {
      break;
    }
  }
  return price;
}

function computeHoldingPerformance(
  payload: PerformanceResponse,
  start: Date,
  end: Date
): HoldingSummary[] {
  const positions = payload.positions;
  const results: HoldingSummary[] = [];
  if (!positions.length) return results;

  for (const holding of payload.holdings) {
    const startState = findPositionAt(positions, start);
    const endState = findPositionAt(positions, end) ?? positions[positions.length - 1];
    const startShares = startState?.shares[holding.symbol] ?? 0;
    const endShares = endState?.shares[holding.symbol] ?? 0;
    const series = payload.price_series[holding.symbol];
    const startPrice = priceAt(series, start) ?? 0;
    const endPrice = priceAt(series, end) ?? startPrice;
    const startValue = startShares * startPrice;
    const endValue = endShares * endPrice;
    const gainAbs = endValue - startValue;
    const gainPct = startValue > 0 ? gainAbs / startValue : null;

    results.push({
      ...holding,
      shares: endShares,
      current_value: endValue,
      gain_abs: gainAbs,
      gain_pct: gainPct,
    });
  }
  return results.sort((a, b) => b.current_value - a.current_value);
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
      <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-white">{value}</p>
      {sub && <p className="text-xs text-blue-100/70">{sub}</p>}
    </div>
  );
}
