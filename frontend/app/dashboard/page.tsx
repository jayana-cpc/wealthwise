"use client";

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

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [authStatus, setAuthStatus] = useState<"checking" | "ready" | "error">(
    "checking"
  );
  const [latestUpload, setLatestUpload] = useState<PortfolioUpload | null>(null);
  const [latestStatus, setLatestStatus] = useState<
    "idle" | "loading" | "ready" | "empty" | "error"
  >("idle");
  const [latestError, setLatestError] = useState<string | null>(null);
  const [logoutStatus, setLogoutStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<
    "idle" | "uploading" | "success" | "error"
  >("idle");
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const BACKEND_BASE_URL = useMemo(
    () => process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001",
    []
  );

  const formatValue = (value: Value) => {
    if (value === null || value === undefined || value === "") return "—";
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
        router.replace("/");
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
          router.replace("/");
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

      const res = await fetch(`${BACKEND_BASE_URL}/upload-csv`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (res.status === 401) {
        router.replace("/");
        return;
      }

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        const detail =
          errorBody?.detail ||
          (typeof errorBody === "string" ? errorBody : "Upload failed.");
        throw new Error(detail);
      }

      setUploadStatus("success");
      setUploadMessage("Upload stored in Supabase. Loading saved copy…");
      setSelectedFile(null);
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

  const handleLogout = async () => {
    setLogoutStatus("loading");
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error("Logout failed.");
      }

      setUser(null);
      router.replace("/");
    } catch {
      setLogoutStatus("error");
    }
  };

  const renderRows = (rows: PositionRow[]) => (
    <div className="overflow-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
      <table className="min-w-full border-collapse text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
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
        <tbody className="divide-y divide-zinc-100">
          {rows.map((row, idx) => (
            <tr key={`${row.symbol}-${idx}`} className="hover:bg-zinc-50">
              <td className="px-3 py-2 font-medium text-zinc-900">
                {row.symbol || "—"}
              </td>
              <td className="px-3 py-2 text-zinc-700">{row.description}</td>
              <td className="px-3 py-2 text-zinc-700 text-right tabular-nums">
                {formatValue(row.quantity)}
              </td>
              <td className="px-3 py-2 text-zinc-700 text-right tabular-nums">
                {formatValue(row.price)}
              </td>
              <td className="px-3 py-2 text-zinc-700 text-right tabular-nums">
                {formatValue(row.market_value)}
              </td>
              <td className="px-3 py-2 text-zinc-700 text-right tabular-nums">
                {formatValue(row.gain)}
              </td>
              <td className="px-3 py-2 text-zinc-700 text-right tabular-nums">
                {formatValue(row.gain_pct)}
              </td>
              <td className="px-3 py-2">
                <span className="rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-semibold uppercase text-zinc-600">
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
    <main className="min-h-screen bg-linear-to-br from-zinc-50 via-white to-emerald-50 px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-zinc-500">
              Wealthwise Dashboard
            </p>
            <h1 className="mt-1 text-3xl font-semibold text-zinc-900">
              Upload and review your portfolio
            </h1>
            <p className="mt-1 text-sm text-zinc-600">
              CSV uploads are stored in Supabase and hydrated back into this
              view.
            </p>
          </div>
          {user && (
            <div className="flex flex-wrap items-center gap-3 rounded-full border border-zinc-200 bg-white px-3 py-2 shadow-sm">
              {user.picture && (
                <img
                  src={user.picture}
                  alt={user.name ?? "User avatar"}
                  className="h-9 w-9 rounded-full object-cover"
                />
              )}
              <div>
                <p className="text-sm font-semibold text-zinc-900">
                  {user.name ?? "Signed in"}
                </p>
                <p className="text-xs text-zinc-600">{user.email}</p>
              </div>
              <div className="h-6 w-px bg-zinc-200" aria-hidden />
              <button
                type="button"
                onClick={handleLogout}
                disabled={logoutStatus === "loading"}
                className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {logoutStatus === "loading" ? "Signing out…" : "Log out"}
              </button>
            </div>
          )}
        </header>
        {logoutStatus === "error" && (
          <div className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm">
            Sign out failed. Please try again.
          </div>
        )}

        {authStatus === "checking" && (
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-zinc-600">Verifying your session…</p>
          </div>
        )}

        {authStatus === "ready" && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm lg:col-span-1">
              <h2 className="text-lg font-semibold text-zinc-900">
                Upload CSV
              </h2>
              <p className="mt-1 text-sm text-zinc-600">
                Only available while signed in. Files are stored in Supabase and
                pulled back into this dashboard.
              </p>

              <div className="mt-4 space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                  className="w-full cursor-pointer rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium hover:border-emerald-300 focus:border-emerald-400 focus:outline-none"
                />
                <button
                  onClick={handleUpload}
                  disabled={uploadStatus === "uploading"}
                  className="w-full rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
                >
                  {uploadStatus === "uploading"
                    ? "Uploading…"
                    : "Save CSV to Supabase"}
                </button>
              </div>

              {uploadMessage && (
                <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                  {uploadMessage}
                </div>
              )}
              {uploadError && (
                <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                  {uploadError}
                </div>
              )}
              {selectedFile && (
                <p className="mt-2 text-xs text-zinc-600">
                  Selected: {selectedFile.name}
                </p>
              )}
            </div>

            <div className="lg:col-span-2">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">
                    Latest saved portfolio
                  </h2>
                  <p className="text-sm text-zinc-600">
                    Pulled directly from Supabase.
                  </p>
                </div>
                <button
                  onClick={loadLatestUpload}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Refresh
                </button>
              </div>

              <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                {latestStatus === "loading" && (
                  <p className="text-sm text-zinc-600">Loading latest upload…</p>
                )}
                {latestStatus === "error" && (
                  <p className="text-sm text-rose-700">{latestError}</p>
                )}
                {latestStatus === "empty" && (
                  <p className="text-sm text-zinc-600">
                    No uploads saved yet. Upload a CSV to see it here.
                  </p>
                )}
                {latestStatus === "ready" && latestUpload && (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
                      <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase text-emerald-700">
                        Stored
                      </span>
                      {latestUpload.file_name && (
                        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700">
                          {latestUpload.file_name}
                        </span>
                      )}
                      {latestUpload.created_at && (
                        <span className="text-xs text-zinc-500">
                          Uploaded {new Date(latestUpload.created_at).toLocaleString()}
                        </span>
                      )}
                      {latestUpload.row_count != null && (
                        <span className="text-xs text-zinc-500">
                          {latestUpload.row_count} rows
                        </span>
                      )}
                    </div>

                    <div className="rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3">
                      <p className="text-sm font-semibold text-zinc-900">
                        {latestUpload.payload.metadata.header_line}
                      </p>
                      <p className="text-xs text-zinc-600">
                        {latestUpload.payload.metadata.account_name &&
                          `Account: ${latestUpload.payload.metadata.account_name} · `}
                        {latestUpload.payload.metadata.as_of &&
                          `As of ${latestUpload.payload.metadata.as_of}`}
                      </p>
                    </div>

                    {renderRows(latestUpload.payload.rows)}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {authStatus === "error" && (
          <div className="rounded-2xl border border-rose-100 bg-rose-50 p-6 text-rose-800 shadow-sm">
            We could not verify your session. Please return to the homepage and
            sign in again.
          </div>
        )}
      </div>
    </main>
  );
}
