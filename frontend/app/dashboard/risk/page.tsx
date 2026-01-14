"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type User = {
  email?: string;
  name?: string;
  picture?: string;
};

type AuthStatus = "checking" | "ready" | "error";
type AnalyzeStatus = "idle" | "running" | "success" | "error";
type LatestStatus = "idle" | "loading" | "error";
type SecretStatus = "idle" | "saving" | "success" | "error";

type AnalyzeResponse = {
  analysis_id: string;
  status: string;
  packet: Record<string, any>;
  narratives: Record<string, any>[];
  model?: string | null;
};

type RiskAnalysisRecord = {
  id?: string;
  analysis_id?: string;
  status: string;
  packet: Record<string, any>;
  model?: string | null;
};

type LatestRiskResponse = {
  analysis: RiskAnalysisRecord;
  narratives: Record<string, any>[];
  model?: string | null;
};

export default function RiskPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");

  const [importBatchId, setImportBatchId] = useState<string>("");
  const [localBatchReady, setLocalBatchReady] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<"csv_only" | "enriched">(
    "csv_only"
  );
  const [analysisStatus, setAnalysisStatus] = useState<AnalyzeStatus>("idle");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalyzeResponse | null>(
    null
  );
  const [latestRiskStatus, setLatestRiskStatus] = useState<LatestStatus>("idle");
  const [latestRiskError, setLatestRiskError] = useState<string | null>(null);
  const [deepSeekKey, setDeepSeekKey] = useState("");
  const [secretStatus, setSecretStatus] = useState<SecretStatus>("idle");
  const [secretMessage, setSecretMessage] = useState<string | null>(null);

  const BACKEND_BASE_URL = useMemo(
    () => process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001",
    []
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedBatch = window.localStorage.getItem("ww_last_batch_id");
    if (storedBatch) {
      setImportBatchId(storedBatch);
    }
    setLocalBatchReady(true);
  }, []);

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

  const handleAnalyze = async () => {
    if (!importBatchId) {
      setAnalysisError("Batch ID is required to run analysis. Upload a CSV first.");
      return;
    }
    setAnalysisError(null);
    setAnalysisStatus("running");
    setAnalysisResult(null);
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/risk/analyze`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_id: importBatchId, mode: analysisMode }),
      });
      if (res.status === 401) {
        router.replace("/signin");
        return;
      }
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        const detail =
          errorBody?.detail ||
          (typeof errorBody === "string" ? errorBody : "Risk analysis failed.");
        throw new Error(detail);
      }
      const data = (await res.json()) as AnalyzeResponse;
      setAnalysisResult(data);
      setAnalysisStatus("success");
    } catch (err) {
      setAnalysisStatus("error");
      setAnalysisError(
        err instanceof Error ? err.message : "Risk analysis failed. Please try again."
      );
    }
  };

  const fetchLatestRisk = useCallback(async () => {
    setLatestRiskStatus("loading");
    setLatestRiskError(null);
    try {
      const url = new URL(`${BACKEND_BASE_URL}/api/risk/latest`);
      if (importBatchId) {
        url.searchParams.set("batch_id", importBatchId);
      }
      const res = await fetch(url.toString(), {
        method: "GET",
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
          (typeof errorBody === "string" ? errorBody : "Failed to load analysis.");
        throw new Error(detail);
      }
      const data = (await res.json()) as LatestRiskResponse;
      setAnalysisResult({
        analysis_id: data.analysis.analysis_id ?? data.analysis.id ?? "",
        status: data.analysis.status,
        packet: data.analysis.packet,
        narratives: data.narratives,
        model: data.model ?? data.analysis.model,
      });
      setAnalysisStatus("success");
      setAnalysisError(null);
      setLatestRiskStatus("idle");
    } catch (err) {
      setLatestRiskStatus("error");
      setLatestRiskError(
        err instanceof Error ? err.message : "Could not load latest analysis."
      );
    }
  }, [BACKEND_BASE_URL, importBatchId, router]);

  const initialLatestFetched = useRef(false);

  useEffect(() => {
    if (authStatus !== "ready" || !localBatchReady || initialLatestFetched.current) {
      return;
    }
    initialLatestFetched.current = true;
    fetchLatestRisk();
  }, [authStatus, localBatchReady, fetchLatestRisk]);

  const handleSaveDeepSeekKey = async () => {
    const trimmed = deepSeekKey.trim();
    if (!trimmed) {
      setSecretStatus("error");
      setSecretMessage("Enter a DeepSeek API key.");
      return;
    }
    setSecretStatus("saving");
    setSecretMessage(null);
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/settings/deepseek-key`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: trimmed }),
      });
      if (res.status === 401) {
        router.replace("/signin");
        return;
      }
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        const detail =
          errorBody?.detail ||
          (typeof errorBody === "string" ? errorBody : "Failed to store key.");
        throw new Error(detail);
      }
      setSecretStatus("success");
      setSecretMessage("DeepSeek key stored securely.");
      setDeepSeekKey("");
    } catch (err) {
      setSecretStatus("error");
      setSecretMessage(err instanceof Error ? err.message : "Failed to store key.");
    }
  };

  const renderAnalysisResult = () => {
    if (!analysisResult) return null;
    const packet = analysisResult.packet ?? {};
    const concentration = packet.concentration ?? {};
    const scenarios = packet.scenarios ?? {};
    const marketMetrics = packet.market_metrics;

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-blue-100/80">
          <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold uppercase text-emerald-200">
            Analysis
          </span>
          <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-white">
            {analysisResult.status}
          </span>
          {analysisResult.model && (
            <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-blue-100">
              Narratives: {analysisResult.model}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
              Portfolio value
            </p>
            <p className="text-2xl font-semibold text-white">
              {packet.portfolio_value != null
                ? `$${packet.portfolio_value.toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}`
                : "-"}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
              Concentration (HHI)
            </p>
            <p className="text-2xl font-semibold text-white">
              {concentration.hhi != null ? concentration.hhi.toFixed(3) : "-"}
            </p>
          </div>
        </div>

        {concentration.top_positions?.length > 0 && (
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
              Top weights
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {concentration.top_positions.map(
                (pos: { symbol: string; weight: number }) => (
                  <span
                    key={pos.symbol}
                    className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-blue-100"
                  >
                    {pos.symbol}: {(pos.weight * 100).toFixed(1)}%
                  </span>
                )
              )}
            </div>
          </div>
        )}

        {scenarios.shocks && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                  Stress scenarios
                </p>
                <p className="text-sm text-blue-100/80">
                  Dollar impact of -10%, -20%, -30% moves on portfolio and holdings.
                </p>
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {Object.entries(scenarios.shocks).map(([shock, data]) => {
                const change = (data as any).portfolio_change ?? 0;
                return (
                  <div
                    key={shock}
                    className="rounded-xl border border-white/10 bg-white/10 px-4 py-3"
                  >
                    <p className="text-xs font-semibold uppercase text-blue-100/70">
                      {Math.round(parseFloat(shock) * 100)}%
                    </p>
                    <p className="text-lg font-semibold text-white">
                      {change
                        ? `$${change.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                        : "-"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                Market metrics
              </p>
              <p className="text-sm text-blue-100/80">
                Volatility, drawdown, beta, and correlation using Alpaca bars.
              </p>
            </div>
            <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold text-blue-100">
              {packet.market_data_status ?? "unknown"}
            </span>
          </div>

          {marketMetrics ? (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-white/10 bg-white/10 px-4 py-3">
                <p className="text-xs font-semibold uppercase text-blue-100/70">
                  Volatility (ann.)
                </p>
                <p className="text-lg font-semibold text-white">
                  {marketMetrics.volatility != null
                    ? `${(marketMetrics.volatility * 100).toFixed(2)}%`
                    : "-"}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/10 px-4 py-3">
                <p className="text-xs font-semibold uppercase text-blue-100/70">
                  Max drawdown
                </p>
                <p className="text-lg font-semibold text-white">
                  {marketMetrics.max_drawdown != null
                    ? `${(marketMetrics.max_drawdown * 100).toFixed(2)}%`
                    : "-"}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/10 px-4 py-3">
                <p className="text-xs font-semibold uppercase text-blue-100/70">
                  Beta vs SPY
                </p>
                <p className="text-lg font-semibold text-white">
                  {marketMetrics.beta != null ? marketMetrics.beta.toFixed(2) : "-"}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/10 px-4 py-3">
                <p className="text-xs font-semibold uppercase text-blue-100/70">
                  Avg correlation
                </p>
                <p className="text-lg font-semibold text-white">
                  {marketMetrics.avg_correlation != null
                    ? marketMetrics.avg_correlation.toFixed(2)
                    : "-"}
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-blue-100/75">
              Market data not available yet. Provide an enriched analysis to populate.
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-indigo-900/30">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                Narratives
              </p>
              <p className="text-sm text-blue-100/80">
                Plain-English summaries based on the risk packet.
              </p>
            </div>
          </div>
          {analysisResult.narratives?.length ? (
            <div className="mt-3 space-y-3">
              {analysisResult.narratives.map((item, idx) => (
                <div
                  key={item.id ?? idx}
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold uppercase text-emerald-200">
                      {item.severity ?? "info"}
                    </span>
                    <p className="text-sm font-semibold text-white">
                      {item.headline ?? "Narrative"}
                    </p>
                  </div>
                  <p className="mt-1 text-sm text-blue-100/85">{item.summary ?? "-"}</p>
                  {item.why_it_matters && (
                    <p className="mt-1 text-xs text-blue-100/70">
                      Why it matters: {item.why_it_matters}
                    </p>
                  )}
                  {Array.isArray(item.watch_thresholds) && item.watch_thresholds.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-blue-100/70">
                      {item.watch_thresholds.map((w: string, wIdx: number) => (
                        <span
                          key={wIdx}
                          className="rounded-full border border-white/15 bg-white/5 px-3 py-1 font-medium text-blue-100"
                        >
                          {w}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-blue-100/75">No narratives yet.</p>
          )}
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-linear-to-br from-[#050712] via-[#0a0f21] to-[#0f1a3d] text-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-blue-100/70">
              Risk analysis
            </p>
            <h1 className="mt-1 text-3xl font-semibold text-white">
              Build narratives from your portfolio
            </h1>
            <p className="mt-1 text-sm text-blue-100/80">
              Use the batch ID from your CSV upload to generate risk packets and narratives.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/dashboard/upload"
              className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:border-white/40 hover:bg-white/10"
            >
              Upload CSV
            </Link>
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

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-indigo-900/30">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                      Run risk analysis
                    </p>
                    <h2 className="text-lg font-semibold text-white">
                      Generate packet + narratives
                    </h2>
                    <p className="text-sm text-blue-100/80">
                      Paste your batch ID from the upload workspace. We store the last ID locally for you.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={fetchLatestRisk}
                      disabled={latestRiskStatus === "loading"}
                      className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:border-white/40 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {latestRiskStatus === "loading" ? "Loading..." : "Fetch latest"}
                    </button>
                    <button
                      onClick={handleAnalyze}
                      disabled={analysisStatus === "running"}
                      className="rounded-lg bg-linear-to-r from-indigo-500 via-purple-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:translate-y-px hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {analysisStatus === "running" ? "Running..." : "Run analysis"}
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-2 sm:col-span-2">
                    <label className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-100/70">
                      Batch ID
                    </label>
                    <input
                      value={importBatchId}
                      onChange={(e) => setImportBatchId(e.target.value)}
                      placeholder="Paste batch id from upload response"
                      className="w-full rounded-xl border border-white/20 bg-white/5 px-4 py-3 text-sm text-white placeholder-blue-100/60 focus:border-indigo-400/70 focus:outline-none"
                    />
                    <p className="text-[11px] text-blue-100/70">
                      Need a new batch? Upload a CSV first. We use your stored ID when available.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-100/70">
                      Mode
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {(["csv_only", "enriched"] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setAnalysisMode(mode)}
                          className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                            analysisMode === mode
                              ? "border-indigo-400/60 bg-indigo-500/15 text-white"
                              : "border-white/20 bg-white/5 text-blue-100 hover:border-white/35 hover:bg-white/10"
                          }`}
                        >
                          {mode === "csv_only" ? "CSV only" : "Enriched (Alpaca)"}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-blue-100/70">
                      Enriched mode fetches 1Day bars (252d) and SPY for beta/correlation.
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-100/70">
                    Status
                  </label>
                  <div className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm text-blue-100">
                    {analysisStatus === "running"
                      ? "Running analysis..."
                      : analysisStatus === "success"
                      ? "Complete"
                      : analysisStatus === "error"
                      ? "Error"
                      : "Idle"}
                  </div>
                  {analysisError && (
                    <p className="text-[11px] text-rose-200">{analysisError}</p>
                  )}
                  {latestRiskError && (
                    <p className="text-[11px] text-rose-200">{latestRiskError}</p>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-indigo-900/30">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                      Settings
                    </p>
                    <h2 className="text-lg font-semibold text-white">
                      DeepSeek API key
                    </h2>
                    <p className="mt-1 text-sm text-blue-100/80">
                      Stored encrypted in Supabase. Required for narrative generation.
                    </p>
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  <input
                    type="password"
                    placeholder="Paste DeepSeek API key"
                    value={deepSeekKey}
                    onChange={(e) => setDeepSeekKey(e.target.value)}
                    className="w-full rounded-xl border border-white/20 bg-white/5 px-4 py-3 text-sm text-white placeholder-blue-100/60 focus:border-indigo-400/70 focus:outline-none"
                  />
                  <button
                    onClick={handleSaveDeepSeekKey}
                    disabled={secretStatus === "saving"}
                    className="w-full rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/30 transition hover:border-white/40 hover:bg-white/15 disabled:opacity-60"
                  >
                    {secretStatus === "saving" ? "Saving..." : "Store DeepSeek key"}
                  </button>
                  {secretMessage && (
                    <div
                      className={`rounded-lg px-3 py-2 text-xs font-medium ${
                        secretStatus === "success"
                          ? "border border-emerald-400/40 bg-emerald-500/10 text-emerald-100"
                          : secretStatus === "error"
                          ? "border border-rose-400/40 bg-rose-500/10 text-rose-100"
                          : "border border-white/15 bg-white/5 text-blue-100"
                      }`}
                    >
                      {secretMessage}
                    </div>
                  )}
                  <p className="text-[11px] text-blue-100/70">
                    We never return the key to the client. Rotate it in your DeepSeek account any time.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-indigo-900/30">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.15em] text-blue-100/70">
                    Risk output
                  </p>
                  <h2 className="text-lg font-semibold text-white">
                    Narratives + supporting metrics
                  </h2>
                  <p className="text-sm text-blue-100/80">
                    Run an analysis to see concentration, scenarios, market metrics, and narratives.
                  </p>
                </div>
              </div>
              <div className="mt-4">
                {analysisStatus === "running" && (
                  <p className="text-sm text-blue-100/80">Crunching numbers...</p>
                )}
                {analysisResult ? (
                  renderAnalysisResult()
                ) : (
                  <p className="text-sm text-blue-100/80">
                    Provide a batch ID and run analysis to populate this section.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
