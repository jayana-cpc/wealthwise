"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Value = string | number | null | undefined;

type PositionRow = {
  symbol: string;
  description: string;
  quantity?: Value;
  price?: Value;
  price_change?: Value;
  price_change_pct?: Value;
  market_value?: Value;
  day_change?: Value;
  day_change_pct?: Value;
  cost_basis?: Value;
  gain?: Value;
  gain_pct?: Value;
  reinvest?: string | null;
  reinvest_capital_gains?: string | null;
  security_type?: string | null;
  row_type: string;
};

type AccountMetadata = {
  header_line: string;
  account_name?: string | null;
  as_of?: string | null;
};

type PositionsPayload = {
  metadata: AccountMetadata;
  rows: PositionRow[];
};

type PortfolioUpload = {
  id?: number;
  user_sub: string;
  user_email?: string | null;
  file_name?: string | null;
  row_count?: number | null;
  payload: PositionsPayload;
  raw_csv?: string | null;
  created_at?: string | null;
};

type User = {
  email?: string;
  name?: string;
  picture?: string;
};

type AuthStatus = "checking" | "ready" | "error";
type UploadStatus = "idle" | "uploading" | "success" | "error";

type ImportResponse = {
  batch_id: string;
  row_count?: number | null;
};

export default function UploadPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [latestUpload, setLatestUpload] = useState<PortfolioUpload | null>(null);
  const [latestStatus, setLatestStatus] = useState<
    "idle" | "loading" | "ready" | "empty" | "error"
  >("idle");
  const [latestError, setLatestError] = useState<string | null>(null);
  const [importBatchId, setImportBatchId] = useState<string>("");

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
  }, []);

  const formatValue = (value: Value) => {
    if (value === null || value === undefined || value === "") return "-";
    if (typeof value === "number") return value.toLocaleString();
    return value;
  };

  const loadLatestUpload = useCallback(async () => {
    setLatestError(null);
    setLatestStatus("loading");
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/portfolio-uploads/latest`, {
        method: "GET",
        credentials: "include",
      });

      if (res.status === 401) {
        router.replace("/signin");
        return;
      }

      if (!res.ok) {
        throw new Error("Failed to load your saved CSV.");
      }

      const data = (await res.json()) as PortfolioUpload | null;
      if (!data) {
        setLatestUpload(null);
        setLatestStatus("empty");
        return;
      }

      setLatestUpload(data);
      setLatestStatus("ready");
    } catch (err) {
      setLatestStatus("error");
      setLatestError(
        err instanceof Error ? err.message : "Could not fetch latest upload."
      );
    }
  }, [BACKEND_BASE_URL, router]);

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
        await loadLatestUpload();
      } catch {
        setAuthStatus("error");
      }
    };

    verifySession();
  }, [BACKEND_BASE_URL, loadLatestUpload, router]);

  const handleUpload = async () => {
    if (!selectedFile) {
      setUploadError("Choose a CSV file to upload.");
      return;
    }

    setUploadStatus("uploading");
    setUploadMessage(null);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const res = await fetch(`${BACKEND_BASE_URL}/api/portfolio/import/holdings`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (res.status === 401) {
        router.replace("/signin");
        return;
      }

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        const detail =
          errorBody?.detail ||
          (typeof errorBody === "string" ? errorBody : "Upload failed.");
        throw new Error(detail);
      }

      const data = (await res.json()) as ImportResponse;
      setUploadStatus("success");
      setUploadMessage(
        `Saved import batch${data.batch_id ? ` ${data.batch_id.slice(0, 8)}...` : ""}.`
      );
      setSelectedFile(null);
      setImportBatchId(data.batch_id);
      if (typeof window !== "undefined" && data.batch_id) {
        window.localStorage.setItem("ww_last_batch_id", data.batch_id);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      await loadLatestUpload();
    } catch (err) {
      setUploadStatus("error");
      setUploadMessage(null);
      setUploadError(
        err instanceof Error ? err.message : "Upload failed. Please try again."
      );
    }
  };

  const renderRows = (rows: PositionRow[]) => (
    <div className="overflow-auto rounded-xl border border-white/10 bg-white/5 shadow-xl shadow-indigo-900/30">
      <table className="min-w-full border-collapse text-sm">
        <thead className="bg-white/10 text-left text-xs uppercase tracking-wide text-blue-100/70">
          <tr>
            <th className="px-3 py-3">Symbol</th>
            <th className="px-3 py-3">Description</th>
            <th className="px-3 py-3 text-right">Qty</th>
            <th className="px-3 py-3 text-right">Price</th>
            <th className="px-3 py-3 text-right">Mkt Value</th>
            <th className="px-3 py-3 text-right">Gain $</th>
            <th className="px-3 py-3 text-right">Gain %</th>
            <th className="px-3 py-3">Type</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((row, idx) => (
            <tr key={`${row.symbol}-${idx}`} className="hover:bg-white/5">
              <td className="px-3 py-2 font-medium text-white">
                {row.symbol || "-"}
              </td>
              <td className="px-3 py-2 text-blue-100/80">{row.description}</td>
              <td className="px-3 py-2 text-right text-blue-100/80 tabular-nums">
                {formatValue(row.quantity)}
              </td>
              <td className="px-3 py-2 text-right text-blue-100/80 tabular-nums">
                {formatValue(row.price)}
              </td>
              <td className="px-3 py-2 text-right text-blue-100/80 tabular-nums">
                {formatValue(row.market_value)}
              </td>
              <td className="px-3 py-2 text-right text-blue-100/80 tabular-nums">
                {formatValue(row.gain)}
              </td>
              <td className="px-3 py-2 text-right text-blue-100/80 tabular-nums">
                {formatValue(row.gain_pct)}
              </td>
              <td className="px-3 py-2">
                <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-semibold uppercase text-blue-100">
                  {row.row_type}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <main className="min-h-screen bg-linear-to-br from-[#050712] via-[#0a0f21] to-[#0f1a3d] text-white">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-blue-100/70">
              CSV Upload
            </p>
            <h1 className="mt-1 text-3xl font-semibold text-white">
              Send a portfolio to Supabase
            </h1>
            <p className="mt-1 text-sm text-blue-100/80">
              Upload a CSV and review the hydrated copy on this page.
            </p>
          </div>
          <Link
            href="/dashboard"
            className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:border-white/40 hover:bg-white/10"
          >
            Back to dashboard
          </Link>
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

            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-indigo-900/30">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    Upload holdings (risk pipeline)
                  </h2>
                  <p className="text-sm text-blue-100/80">
                    Creates a portfolio import batch for analysis. We store the batch ID for you.
                  </p>
                </div>
                <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-[11px] font-semibold uppercase text-emerald-200">
                  Secure
                </span>
              </div>

              <div className="mt-4 space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                  className="w-full cursor-pointer rounded-xl border border-dashed border-white/25 bg-white/5 px-4 py-3 text-sm text-blue-100/85 file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:border-indigo-300/50 focus:border-indigo-400/70 focus:outline-none"
                />
                <button
                  onClick={handleUpload}
                  disabled={uploadStatus === "uploading"}
                  className="w-full rounded-xl bg-linear-to-r from-indigo-500 via-purple-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:translate-y-px hover:shadow-xl disabled:opacity-60"
                >
                  {uploadStatus === "uploading" ? "Uploading..." : "Save CSV to Supabase"}
                </button>
              </div>

              {uploadMessage && (
                <div className="mt-3 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-100">
                  {uploadMessage}
                </div>
              )}
              {uploadError && (
                <div className="mt-3 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-100">
                  {uploadError}
                </div>
              )}
              {selectedFile && (
                <p className="mt-2 text-xs text-blue-100/75">
                  Selected: {selectedFile.name}
                </p>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-blue-100/70">
                <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 font-medium text-blue-100">
                  3 column minimum
                </span>
                <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 font-medium text-blue-100">
                  CSV or text/csv only
                </span>
                <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 font-medium text-blue-100">
                  Batch ID: {importBatchId ? `${importBatchId.slice(0, 8)}...` : "pending"}
                </span>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-blue-100/80">
                <span>Next step:</span>
                <Link
                  href="/dashboard/risk"
                  className="rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-semibold text-white transition hover:border-white/40 hover:bg-white/10"
                >
                  Open risk analysis
                </Link>
                <span className="text-xs text-blue-100/70">
                  Batch ID is saved locally for that tab.
                </span>
              </div>
            </div>

            <div
              id="latest-portfolio"
              className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-indigo-900/30"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    Legacy saved portfolio
                  </h2>
                  <p className="text-sm text-blue-100/80">
                    Uses the earlier upload endpoint for comparison. New risk uploads may not appear here.
                  </p>
                </div>
                <button
                  onClick={loadLatestUpload}
                  disabled={latestStatus === "loading"}
                  className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:border-white/40 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {latestStatus === "loading" ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              <div className="mt-3 rounded-xl border border-dashed border-white/15 bg-white/5 px-4 py-3 text-sm text-blue-100">
                <p className="font-semibold text-white">Heads up</p>
                <p className="text-xs text-blue-100/75">
                  This workspace is for uploads and the hydrated table. Run risk analysis from the dedicated tab.
                </p>
              </div>

              <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-5 shadow-lg shadow-indigo-900/30">
                {latestStatus === "loading" && (
                  <p className="text-sm text-blue-100/80">Loading latest upload...</p>
                )}
                {latestStatus === "error" && (
                  <p className="text-sm text-rose-200">{latestError}</p>
                )}
                {latestStatus === "empty" && (
                  <p className="text-sm text-blue-100/80">
                    No uploads saved yet. Upload a CSV to see it here.
                  </p>
                )}
                {latestStatus === "idle" && (
                  <p className="text-sm text-blue-100/80">
                    Ready to fetch your saved CSV. Tap refresh if it does not load automatically.
                  </p>
                )}
                {latestStatus === "ready" && latestUpload && (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-blue-100">
                      <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold uppercase text-emerald-200">
                        Stored
                      </span>
                      {latestUpload.file_name && (
                        <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-blue-100">
                          {latestUpload.file_name}
                        </span>
                      )}
                      {latestUpload.created_at && (
                        <span className="text-xs text-blue-100/70">
                          Uploaded {new Date(latestUpload.created_at).toLocaleString()}
                        </span>
                      )}
                      {latestUpload.row_count != null && (
                        <span className="text-xs text-blue-100/70">
                          {latestUpload.row_count} rows
                        </span>
                      )}
                    </div>

                    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                      <p className="text-sm font-semibold text-white">
                        {latestUpload.payload.metadata.header_line}
                      </p>
                      <p className="text-xs text-blue-100/75">
                        {latestUpload.payload.metadata.account_name &&
                          `Account: ${latestUpload.payload.metadata.account_name} | `}
                        {latestUpload.payload.metadata.as_of &&
                          `As of ${latestUpload.payload.metadata.as_of}`}
                      </p>
                    </div>

                    {renderRows(latestUpload.payload.rows)}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
