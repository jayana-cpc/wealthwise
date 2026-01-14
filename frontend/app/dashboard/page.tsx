"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

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
  const [logoutStatus, setLogoutStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");

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
      router.replace("/signin");
    } catch {
      setLogoutStatus("error");
    }
  };

  return (
    <main className="min-h-screen bg-linear-to-br from-[#050712] via-[#0a0f21] to-[#0f1a3d] px-6 py-10 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-blue-100/70">
              WealthWise dashboard
            </p>
            <h1 className="mt-1 text-3xl font-semibold text-white">
              Your portfolio hub
            </h1>
            
          </div>
          {user && (
            <div className="flex flex-wrap items-center gap-3 rounded-full border border-white/15 bg-white/5 px-3 py-2 shadow-lg shadow-indigo-900/40">
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
              <div className="h-6 w-px bg-white/10" aria-hidden />
              <button
                type="button"
                onClick={handleLogout}
                disabled={logoutStatus === "loading"}
                className="rounded-full border border-white/20 px-3 py-1 text-xs font-semibold text-white transition hover:border-white/40 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {logoutStatus === "loading" ? "Signing out..." : "Log out"}
              </button>
            </div>
          )}
        </header>
        {logoutStatus === "error" && (
          <div className="rounded-2xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100 shadow-lg shadow-rose-900/30">
            Sign out failed. Please try again.
          </div>
        )}

        {authStatus === "checking" && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-blue-100 shadow-lg shadow-indigo-900/30">
            Verifying your session...
          </div>
        )}

        {authStatus === "ready" && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              {/* <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-indigo-900/30">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="mt-1 text-lg font-semibold text-white">
                      CSV Upload
                    </h2>
                  </div>
                </div>
                <div className="mt-5 space-y-2">
                  <Link
                    href="/dashboard/upload"
                    className="inline-flex w-full items-center justify-between rounded-xl bg-linear-to-r from-indigo-500 via-purple-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:translate-y-px hover:shadow-xl"
                  >
                    Open upload page
                    <span aria-hidden className="text-base">
                      -&gt;
                    </span>
                  </Link>
                </div>
              </div> */}

              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-indigo-900/30">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-blue-100/70">
                      Performance dashboard
                    </p>
                    <h2 className="mt-1 text-lg font-semibold text-white">
                      Portfolio value & benchmarks
                    </h2>
                    <p className="mt-1 text-sm text-blue-100/80">
                      Reconstructs positions from your transactions and charts them against SPY and IWM.
                    </p>
                  </div>
                  <span className="rounded-full bg-blue-500/20 px-3 py-1 text-[10px] font-semibold uppercase text-blue-100">
                    Live
                  </span>
                </div>
                <div className="mt-5 space-y-2">
                  <Link
                    href="/dashboard/performance"
                    className="inline-flex w-full items-center justify-between rounded-xl bg-linear-to-r from-sky-500 via-blue-500 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:translate-y-px hover:shadow-xl"
                  >
                    Open performance tab
                    <span aria-hidden className="text-base">
                      -&gt;
                    </span>
                  </Link>
                </div>
              </div>

              </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-indigo-900/30">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-blue-100/70">
                      Risk analysis
                    </p>
                    <h2 className="mt-1 text-lg font-semibold text-white">
                      Generate narratives
                    </h2>
                    <p className="mt-1 text-sm text-blue-100/80">
                      Use your saved batch ID to run the risk packet, scenarios, and narratives.
                    </p>
                  </div>
                  <span className="rounded-full bg-indigo-500/20 px-3 py-1 text-[10px] font-semibold uppercase text-indigo-100">
                    New
                  </span>
                </div>
                <div className="mt-5 space-y-2">
                  <Link
                    href="/dashboard/risk"
                    className="inline-flex w-full items-center justify-between rounded-xl bg-linear-to-r from-indigo-500 via-purple-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:translate-y-px hover:shadow-xl"
                  >
                    Open risk analysis
                    <span aria-hidden className="text-base">
                      -&gt;
                    </span>
                  </Link>
                </div>
              </div>
            </div>

            
          </section>
        )}

        {authStatus === "error" && (
          <div className="rounded-2xl border border-rose-400/40 bg-rose-500/10 p-6 text-rose-100 shadow-lg shadow-rose-900/30">
            We could not verify your session. Please return to the homepage and sign in again.
          </div>
        )}
      </div>
    </main>
  );
}
