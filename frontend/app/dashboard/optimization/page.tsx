"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Compass } from "lucide-react";
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

type OptimizationMethod = {
  key: string;
  goal: string;
  label: string;
  description: string;
  tier: string;
  uses_return_model: boolean;
  uses_covariance: boolean;
};

type AllocationWeights = {
  recommended: Record<string, number>;
  current: Record<string, number>;
  equal_weight: Record<string, number>;
};

type TradeSuggestion = {
  symbol: string;
  action: "buy" | "sell" | "hold";
  shares: number;
  notional: number;
};

type PortfolioMetrics = {
  total_return: number | null;
  cagr: number | null;
  volatility: number | null;
  max_drawdown: number | null;
  sharpe: number | null;
  tracking_error?: number | null;
};

type BacktestPoint = {
  date: string;
  recommended: number;
  current: number;
  equal_weight: number;
  benchmark?: number | null;
};

type OptimizationResponse = {
  method: string;
  goal: string;
  universe: string[];
  lookback_days: number;
  benchmark: string;
  weights: AllocationWeights;
  trades: TradeSuggestion[];
  metrics: Record<string, PortfolioMetrics>;
  backtest: BacktestPoint[];
  explain: Record<string, any>;
  warnings: string[];
};

type ConstraintState = {
  max_position_pct: string;
  min_position_pct: string;
  max_turnover: string;
  rebalance_budget: string;
  no_short: boolean;
};

const FALLBACK_METHODS: OptimizationMethod[] = [
  {
    key: "equal_weight",
    goal: "Simplify",
    label: "Equal Weight",
    description: "Same weight for every holding.",
    tier: "A",
    uses_return_model: false,
    uses_covariance: false,
  },
  {
    key: "inverse_vol",
    goal: "Simplify",
    label: "Inverse Volatility",
    description: "Size inversely to historical volatility.",
    tier: "A",
    uses_return_model: false,
    uses_covariance: true,
  },
  {
    key: "gmv",
    goal: "Lower volatility",
    label: "Global Minimum Variance",
    description: "Minimize overall portfolio variance (long-only).",
    tier: "A",
    uses_return_model: false,
    uses_covariance: true,
  },
  {
    key: "risk_parity",
    goal: "Balanced risk",
    label: "Equal Risk Contribution",
    description: "Each holding contributes the same to risk.",
    tier: "A",
    uses_return_model: false,
    uses_covariance: true,
  },
  {
    key: "hrp",
    goal: "Balanced risk",
    label: "Hierarchical Risk Parity",
    description: "Cluster-aware risk balancing.",
    tier: "A",
    uses_return_model: false,
    uses_covariance: true,
  },
  {
    key: "max_diversification",
    goal: "More diversified",
    label: "Maximum Diversification",
    description: "Maximize diversification ratio.",
    tier: "A",
    uses_return_model: false,
    uses_covariance: true,
  },
];

const LOOKBACK_OPTIONS = [
  { key: "1Y", label: "1 year" },
  { key: "3Y", label: "3 years" },
  { key: "5Y", label: "5 years" },
  { key: "MAX", label: "Max available" },
] as const;

const COV_OPTIONS = [
  { key: "shrinkage", label: "Shrinkage (default)", helper: "Stable, reduces noise" },
  { key: "sample", label: "Sample", helper: "Fast, may be noisy" },
  { key: "ewma", label: "EWMA", helper: "Favors recent moves" },
] as const;

const RETURN_OPTIONS = [
  { key: "shrunk_mean", label: "Shrunk mean", helper: "Mean reversion toward 0" },
  { key: "historical_mean", label: "Historical mean", helper: "Unadjusted average" },
  { key: "momentum", label: "Momentum (12-1)", helper: "Trend-aware proxy" },
] as const;

const BENCHMARKS = ["SPY", "IWM"];

type ViewMode = "indexed" | "level";

export default function OptimizationPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [authStatus, setAuthStatus] = useState<"checking" | "ready" | "error">("checking");
  const [methods, setMethods] = useState<OptimizationMethod[]>([]);
  const [methodsStatus, setMethodsStatus] = useState<"idle" | "loading" | "error">("idle");

  const [selectedMethod, setSelectedMethod] = useState<string>("risk_parity");
  const [lookback, setLookback] = useState<"1Y" | "3Y" | "5Y" | "MAX">("1Y");
  const [covModel, setCovModel] = useState<string>("shrinkage");
  const [returnModel, setReturnModel] = useState<string>("shrunk_mean");
  const [benchmark, setBenchmark] = useState<string>("SPY");
  const [constraints, setConstraints] = useState<ConstraintState>({
    max_position_pct: "",
    min_position_pct: "",
    max_turnover: "",
    rebalance_budget: "",
    no_short: true,
  });
  const [constraintsOpen, setConstraintsOpen] = useState<boolean>(false);

  const [result, setResult] = useState<OptimizationResponse | null>(null);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "error">("idle");
  const [runError, setRunError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("indexed");

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
    const loadMethods = async () => {
      setMethodsStatus("loading");
      try {
        const res = await fetch(`${BACKEND_BASE_URL}/api/optimize/methods`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { methods: OptimizationMethod[] };
        setMethods(data.methods);
        if (!data.methods.find((m) => m.key === selectedMethod) && data.methods.length) {
          setSelectedMethod(data.methods[0].key);
        }
        setMethodsStatus("idle");
      } catch {
        setMethodsStatus("error");
      }
    };
    if (authStatus === "ready") {
      loadMethods();
    }
  }, [BACKEND_BASE_URL, authStatus, selectedMethod]);

  const methodOptions = methods.length ? methods : FALLBACK_METHODS;

  const goalBuckets = useMemo(() => {
    const grouped: Record<string, OptimizationMethod[]> = {};
    methodOptions.forEach((m) => {
      grouped[m.goal] = grouped[m.goal] ? [...grouped[m.goal], m] : [m];
    });
    return grouped;
  }, [methodOptions]);

  const handleRun = async () => {
    setRunStatus("running");
    setRunError(null);
    setResult(null);

    const payload: any = {
      method: selectedMethod,
      lookback,
      cov_model: covModel,
      return_model: returnModel,
      benchmark,
      constraints: {
        max_position_pct: constraints.max_position_pct
          ? Number(constraints.max_position_pct) / 100
          : undefined,
        min_position_pct: constraints.min_position_pct
          ? Number(constraints.min_position_pct) / 100
          : undefined,
        max_turnover: constraints.max_turnover ? Number(constraints.max_turnover) / 100 : undefined,
        rebalance_budget: constraints.rebalance_budget
          ? Number(constraints.rebalance_budget)
          : undefined,
        no_short: constraints.no_short,
      },
    };

    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/optimize/run`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        router.replace("/signin");
        return;
      }
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        const detail =
          errorBody?.detail ||
          (typeof errorBody === "string" ? errorBody : "Optimization failed. Try again.");
        throw new Error(detail);
      }
      const data = (await res.json()) as OptimizationResponse;
      setResult(data);
      setRunStatus("idle");
    } catch (err) {
      setRunStatus("error");
      setRunError(err instanceof Error ? err.message : "Optimization failed. Please retry.");
    }
  };

  const chartData = useMemo(() => {
    if (!result) return [];
    return result.backtest.map((point) => {
      const base = (value: number | null | undefined) =>
        viewMode === "indexed" ? (value != null ? (value - 1) * 100 : null) : value;
      return {
        date: point.date,
        Recommended: base(point.recommended),
        Current: base(point.current),
        "Equal weight": base(point.equal_weight),
        Benchmark: base(point.benchmark ?? null),
      };
    });
  }, [result, viewMode]);

  const weightRows = useMemo(() => {
    if (!result) return [];
    const syms = Array.from(
      new Set([
        ...Object.keys(result.weights.recommended),
        ...Object.keys(result.weights.current),
        ...Object.keys(result.weights.equal_weight),
      ])
    );
    return syms
      .map((sym) => ({
        symbol: sym,
        recommended: result.weights.recommended[sym] ?? 0,
        current: result.weights.current[sym] ?? 0,
        equal: result.weights.equal_weight[sym] ?? 0,
      }))
      .sort((a, b) => b.recommended - a.recommended);
  }, [result]);

  const primaryMetrics = result?.metrics?.recommended;
  const benchmarkMetrics = result?.metrics?.benchmark;

  const startSurvey = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("ww-assistant-open", {
        detail: {
          mode: "survey",
          dock: "right",
        },
      })
    );
  };

  return (
    <main className="min-h-screen bg-linear-to-br from-[#050712] via-[#0a0f21] to-[#0f1a3d] text-white">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-blue-100/70">
              Allocation optimization
            </p>
            <h1 className="mt-1 text-3xl font-semibold text-white">
              Target weights & rebalance plan
            </h1>
            <p className="mt-1 text-sm text-blue-100/80">
              Goal-first optimizer built on your holdings, transactions, and Alpaca prices. Compares current, recommended, and equal-weight portfolios with benchmark overlays.
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
                  <p className="text-sm font-semibold text-white">{user.name ?? "Signed in"}</p>
                  <p className="text-xs text-blue-100/70">{user.email}</p>
                </div>
                <span className="ml-auto rounded-full bg-emerald-500/15 px-3 py-1 text-[10px] font-semibold uppercase text-emerald-200">
                  Allocator ready
                </span>
              </div>
            )}

            <div className="rounded-2xl border border-indigo-400/40 bg-indigo-500/10 p-4 shadow-lg shadow-indigo-900/40">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-indigo-500/20 p-2 text-indigo-100">
                    <Compass className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Not sure which optimizer fits?</p>
                    <p className="text-xs text-blue-100/80">
                      Start a quick survey and the WealthWise agent will ask a few goal-based questions to pick the right method for you.
                    </p>
                  </div>
                </div>
                <button
                  onClick={startSurvey}
                  className="inline-flex items-center justify-center rounded-full bg-white/90 px-4 py-2 text-sm font-semibold text-indigo-900 transition hover:-translate-y-[1px] hover:shadow-lg hover:shadow-indigo-900/40"
                >
                  Start survey
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-blue-100/80">
                <span className="rounded-full bg-white/10 px-2 py-1">Goals</span>
                <span className="rounded-full bg-white/10 px-2 py-1">Turnover appetite</span>
                <span className="rounded-full bg-white/10 px-2 py-1">Shorting vs long-only</span>
                <span className="rounded-full bg-white/10 px-2 py-1">Diversification preference</span>
              </div>
            </div>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-blue-100/70">
                      Goal-first presets
                    </p>
                    <p className="text-sm text-blue-100/80">
                      Choose an outcome and we'll pick the matching optimizer. You can still change it.
                    </p>
                  </div>
                  <span className="rounded-full bg-white/10 px-3 py-1 text-[10px] font-semibold uppercase text-blue-100">
                    {methodsStatus === "loading" ? "Loading methods..." : "Methods loaded"}
                  </span>
                </div>
                {methodsStatus === "error" && (
                  <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-50 shadow-inner shadow-amber-900/30">
                    Method catalog unavailable; using built-in presets.
                  </div>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {Object.entries(goalBuckets).map(([goal, items]) => (
                    <button
                      key={goal}
                      onClick={() => setSelectedMethod(items[0]?.key ?? selectedMethod)}
                      className={`rounded-2xl border p-4 text-left shadow-lg transition ${
                        items.find((m) => m.key === selectedMethod)
                          ? "border-emerald-400/60 bg-emerald-500/15"
                          : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10"
                      }`}
                    >
                      <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                        {goal}
                      </p>
                      <ul className="mt-2 space-y-1 text-sm text-blue-100/85">
                        {items.map((m) => (
                          <li key={m.key}>
                            <span className="font-semibold text-white">{m.label}</span>{" "}
                            <span className="text-blue-100/70">- {m.description}</span>
                          </li>
                        ))}
                      </ul>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl shadow-indigo-900/30">
                <div className="flex items-center justify-between">
                  <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                    Config
                  </p>
                  <span className="rounded-full bg-indigo-500/20 px-3 py-1 text-[10px] font-semibold uppercase text-indigo-100">
                    Price-only
                  </span>
                </div>
                <label className="block text-sm">
                  <span className="text-blue-100/70">Method</span>
                  <select
                    value={selectedMethod}
                    onChange={(e) => setSelectedMethod(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white shadow-inner shadow-black/40 focus:border-white/40 focus:outline-none"
                  >
                    {methodOptions.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label} - {m.goal}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-blue-100/70">Lookback</span>
                  <select
                    value={lookback}
                    onChange={(e) => setLookback(e.target.value as any)}
                    className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white shadow-inner shadow-black/40 focus:border-white/40 focus:outline-none"
                  >
                    {LOOKBACK_OPTIONS.map((opt) => (
                      <option key={opt.key} value={opt.key}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-blue-100/70">Benchmark overlay</span>
                  <select
                    value={benchmark}
                    onChange={(e) => setBenchmark(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white shadow-inner shadow-black/40 focus:border-white/40 focus:outline-none"
                  >
                    {BENCHMARKS.map((bmk) => (
                      <option key={bmk} value={bmk}>
                        {bmk}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl shadow-indigo-900/30">
                <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                  Covariance
                </p>
                <div className="space-y-2">
                  {COV_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setCovModel(opt.key)}
                      className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition ${
                        covModel === opt.key
                          ? "border-sky-400/60 bg-sky-500/15 text-white"
                          : "border-white/15 bg-black/20 text-blue-100 hover:border-white/30 hover:bg-white/10"
                      }`}
                    >
                      <span className="font-semibold">{opt.label}</span>
                      <span className="block text-xs text-blue-100/70">{opt.helper}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl shadow-indigo-900/30">
                <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                  Return proxy
                </p>
                <div className="space-y-2">
                  {RETURN_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setReturnModel(opt.key)}
                      className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition ${
                        returnModel === opt.key
                          ? "border-emerald-400/60 bg-emerald-500/15 text-white"
                          : "border-white/15 bg-black/20 text-blue-100 hover:border-white/30 hover:bg-white/10"
                      }`}
                    >
                      <span className="font-semibold">{opt.label}</span>
                      <span className="block text-xs text-blue-100/70">{opt.helper}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl shadow-indigo-900/30">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">Constraints</p>
                    <p className="text-xs text-blue-100/70">Guardrails before we size positions.</p>
                  </div>
                  <button
                    onClick={() => setConstraintsOpen((v) => !v)}
                    className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-white hover:border-white/30 hover:bg-white/10"
                  >
                    {constraintsOpen ? "Hide" : "Show"}
                  </button>
                </div>
                {constraintsOpen && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block text-sm">
                        <span className="text-blue-100/70">Max position %</span>
                        <input
                          type="number"
                          placeholder="e.g. 20"
                          value={constraints.max_position_pct}
                          onChange={(e) =>
                            setConstraints((c) => ({ ...c, max_position_pct: e.target.value }))
                          }
                          className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white shadow-inner shadow-black/40 focus:border-white/40 focus:outline-none"
                        />
                      </label>
                      <label className="block text-sm">
                        <span className="text-blue-100/70">Min position %</span>
                        <input
                          type="number"
                          placeholder="e.g. 1"
                          value={constraints.min_position_pct}
                          onChange={(e) =>
                            setConstraints((c) => ({ ...c, min_position_pct: e.target.value }))
                          }
                          className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white shadow-inner shadow-black/40 focus:border-white/40 focus:outline-none"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block text-sm">
                        <span className="text-blue-100/70">Max turnover %</span>
                        <input
                          type="number"
                          placeholder="e.g. 10"
                          value={constraints.max_turnover}
                          onChange={(e) =>
                            setConstraints((c) => ({ ...c, max_turnover: e.target.value }))
                          }
                          className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white shadow-inner shadow-black/40 focus:border-white/40 focus:outline-none"
                        />
                      </label>
                      <label className="block text-sm">
                        <span className="text-blue-100/70">Rebalance budget ($)</span>
                        <input
                          type="number"
                          placeholder="Optional cap"
                          value={constraints.rebalance_budget}
                          onChange={(e) =>
                            setConstraints((c) => ({ ...c, rebalance_budget: e.target.value }))
                          }
                          className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-white shadow-inner shadow-black/40 focus:border-white/40 focus:outline-none"
                        />
                      </label>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-blue-100/80">
                      <input
                        type="checkbox"
                        checked={constraints.no_short}
                        onChange={(e) => setConstraints((c) => ({ ...c, no_short: e.target.checked }))}
                        className="h-4 w-4 rounded border border-white/30 bg-black/40 accent-indigo-400"
                      />
                      No shorting (long-only)
                    </label>
                  </div>
                )}
                <button
                  onClick={handleRun}
                  disabled={runStatus === "running"}
                  className="w-full rounded-xl bg-linear-to-r from-emerald-500 to-sky-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-900/40 transition hover:translate-y-px hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {runStatus === "running" ? "Optimizing..." : "Run optimization"}
                </button>
                {runError && (
                  <div className="rounded-xl border border-rose-400/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-50 shadow-inner shadow-rose-900/30">
                    {runError}
                  </div>
                )}
              </div>
            </section>

            {result && (
              <div className="space-y-5">
                {result.warnings.length > 0 && (
                  <div className="rounded-2xl border border-amber-300/30 bg-amber-500/10 p-4 text-sm text-amber-50 shadow-lg shadow-amber-900/30">
                    <p className="font-semibold text-white">Data warnings</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-50/90">
                      {result.warnings.map((w, idx) => (
                        <li key={idx}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <MetricCard
                    label="Recommended CAGR"
                    value={
                      primaryMetrics?.cagr != null ? formatPercent(primaryMetrics.cagr) : "-"
                    }
                    sub={
                      primaryMetrics?.volatility != null
                        ? `Vol ${formatPercent(primaryMetrics.volatility)}`
                        : undefined
                    }
                  />
                  <MetricCard
                    label="Max drawdown"
                    value={
                      primaryMetrics?.max_drawdown != null
                        ? formatPercent(primaryMetrics.max_drawdown)
                        : "-"
                    }
                    sub={
                      benchmarkMetrics?.tracking_error != null
                        ? `Tracking error ${formatPercent(benchmarkMetrics.tracking_error)}`
                        : undefined
                    }
                  />
                  <MetricCard
                    label="Total return (run window)"
                    value={
                      primaryMetrics?.total_return != null
                        ? formatPercent(primaryMetrics.total_return)
                        : "-"
                    }
                    sub={`${result.lookback_days} days | Benchmark ${result.benchmark}`}
                  />
                </section>

                <section className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-blue-100/70">
                        Backtest comparison
                      </p>
                      <p className="text-sm text-blue-100/80">
                        Recommended vs current vs equal weight, with optional benchmark overlay.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold">
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
                      <button
                        onClick={() => setViewMode("level")}
                        className={`rounded-full px-3 py-1 transition ${
                          viewMode === "level"
                            ? "bg-white/80 text-indigo-900"
                            : "text-blue-100 hover:bg-white/10"
                        }`}
                      >
                        Growth (x)
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 h-80 w-full rounded-xl border border-white/10 bg-black/20 p-3">
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
                            tickFormatter={(v: number) =>
                              viewMode === "indexed" ? `${v.toFixed(0)}%` : `${v.toFixed(2)}x`
                            }
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
                                : [`${value.toFixed(2)}x`, name]
                            }
                          />
                          <Legend />
                          <Line
                            type="monotone"
                            dataKey="Recommended"
                            stroke="#22d3ee"
                            strokeWidth={2.6}
                            dot={false}
                            activeDot={{ r: 4 }}
                          />
                          <Line
                            type="monotone"
                            dataKey="Current"
                            stroke="#a5b4ff"
                            strokeWidth={1.8}
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="Equal weight"
                            stroke="#fbbf24"
                            strokeDasharray="4 2"
                            strokeWidth={1.6}
                            dot={false}
                          />
                          {chartData.some((d) => d.Benchmark != null) && (
                            <Line
                              type="monotone"
                              dataKey="Benchmark"
                              stroke="#34d399"
                              strokeWidth={1.8}
                              dot={false}
                            />
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-blue-100/80">
                        Not enough data to render chart.
                      </div>
                    )}
                  </div>
                </section>

                <section className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                        Comparison metrics
                      </p>
                      <p className="text-sm text-blue-100/80">
                        Recommended vs current, equal weight, and benchmark (if available).
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 overflow-auto rounded-xl border border-white/10 bg-black/20 shadow-lg shadow-indigo-900/30">
                    <table className="min-w-full border-collapse text-sm">
                      <thead className="bg-white/10 text-left text-xs uppercase tracking-wide text-blue-100/70">
                        <tr>
                          <th className="px-3 py-3">Portfolio</th>
                          <th className="px-3 py-3 text-right">Total return</th>
                          <th className="px-3 py-3 text-right">Vol (ann.)</th>
                          <th className="px-3 py-3 text-right">Max DD</th>
                          <th className="px-3 py-3 text-right">Sharpe-like</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {["recommended", "current", "equal_weight", "benchmark"]
                          .filter((key) => result.metrics[key])
                          .map((key) => {
                            const m = result.metrics[key];
                            const label =
                              key === "recommended"
                                ? "Recommended"
                                : key === "current"
                                ? "Current"
                                : key === "equal_weight"
                                ? "Equal weight"
                                : `Benchmark (${result.benchmark})`;
                            return (
                              <tr key={key} className="hover:bg-white/5">
                                <td className="px-3 py-3 font-semibold text-white">{label}</td>
                                <td className="px-3 py-3 text-right text-blue-100/80">
                                  {m.total_return != null ? formatPercent(m.total_return) : "-"}
                                </td>
                                <td className="px-3 py-3 text-right text-blue-100/80">
                                  {m.volatility != null ? formatPercent(m.volatility) : "-"}
                                </td>
                                <td className="px-3 py-3 text-right text-blue-100/80">
                                  {m.max_drawdown != null ? formatPercent(m.max_drawdown) : "-"}
                                </td>
                                <td className="px-3 py-3 text-right text-blue-100/80">
                                  {m.sharpe != null ? m.sharpe.toFixed(2) : "-"}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                          Weighting plan
                        </p>
                        <p className="text-sm text-blue-100/80">
                          Compare recommended vs current vs equal-weight allocations.
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 overflow-auto rounded-xl border border-white/10 bg-black/20 shadow-lg shadow-indigo-900/30">
                      <table className="min-w-full border-collapse text-sm">
                        <thead className="bg-white/10 text-left text-xs uppercase tracking-wide text-blue-100/70">
                          <tr>
                            <th className="px-3 py-3">Symbol</th>
                            <th className="px-3 py-3 text-right">Recommended</th>
                            <th className="px-3 py-3 text-right">Current</th>
                            <th className="px-3 py-3 text-right">Equal</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {weightRows.map((row) => (
                            <tr key={row.symbol} className="hover:bg-white/5">
                              <td className="px-3 py-3 font-semibold text-white">{row.symbol}</td>
                              <td className="px-3 py-3 text-right text-blue-100/85">
                                {formatPercent(row.recommended)}
                              </td>
                              <td className="px-3 py-3 text-right text-blue-100/70">
                                {formatPercent(row.current)}
                              </td>
                              <td className="px-3 py-3 text-right text-blue-100/70">
                                {formatPercent(row.equal)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                          Rebalance plan
                        </p>
                        <p className="text-sm text-blue-100/80">
                          Share deltas sized off latest prices and optional budget.
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2 text-sm text-blue-100/85">
                      {result.trades.map((t) => (
                        <div
                          key={t.symbol}
                          className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2"
                        >
                          <div>
                            <p className="font-semibold text-white">{t.symbol}</p>
                            <p className="text-xs text-blue-100/70">
                              {t.action === "hold" ? "Hold" : t.action === "buy" ? "Buy" : "Sell"}{" "}
                              {Math.abs(t.shares).toFixed(2)} shares
                            </p>
                          </div>
                          <span
                            className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase ${
                              t.action === "buy"
                                ? "bg-emerald-500/15 text-emerald-200"
                                : t.action === "sell"
                                ? "bg-rose-500/15 text-rose-200"
                                : "bg-white/10 text-blue-100"
                            }`}
                          >
                            {formatCurrency(t.notional)}
                          </span>
                        </div>
                      ))}
                      {result.trades.length === 0 && (
                        <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-blue-100/70">
                          No trades recommended for this run.
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                        Why these weights
                      </p>
                      <p className="text-sm text-blue-100/80">
                        Inputs, models, and constraints captured for transparency.
                      </p>
                    </div>
                    <span className="rounded-full bg-white/10 px-3 py-1 text-[10px] font-semibold uppercase text-blue-100">
                      {result.goal}
                    </span>
                  </div>
                  <div className="mt-3 space-y-2 text-sm text-blue-100/85">
                    <div className="rounded-xl border border-white/10 bg-black/25 px-3 py-2">
                      <p className="text-xs uppercase tracking-[0.1em] text-blue-100/70">Models</p>
                      <p>
                        Covariance: <span className="font-semibold text-white">{covModel}</span> | Return proxy:{" "}
                        <span className="font-semibold text-white">{returnModel}</span> | Benchmark:{" "}
                        <span className="font-semibold text-white">{result.benchmark}</span>
                      </p>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/25 px-3 py-2">
                      <p className="text-xs uppercase tracking-[0.1em] text-blue-100/70">Constraints</p>
                      <p>
                        Max position: {constraints.max_position_pct || "-"}% | Min position:{" "}
                        {constraints.min_position_pct || "-"}% | Max turnover:{" "}
                        {constraints.max_turnover || "-"}% | Budget:{" "}
                        {constraints.rebalance_budget ? formatCurrency(Number(constraints.rebalance_budget)) : "-"} |{" "}
                        No shorting enforced
                      </p>
                    </div>
                    {result.explain?.notes && Array.isArray(result.explain.notes) && (
                      <ul className="list-disc space-y-1 pl-5 text-xs text-blue-100/70">
                        {result.explain.notes.map((note: string, idx: number) => (
                          <li key={idx}>{note}</li>
                        ))}
                      </ul>
                    )}
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

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatCurrency(value: number): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(value) >= 100000 ? 0 : 2,
  });
  return formatter.format(value);
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
      <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-white">{value}</p>
      {sub && <p className="text-xs text-blue-100/70">{sub}</p>}
    </div>
  );
}
