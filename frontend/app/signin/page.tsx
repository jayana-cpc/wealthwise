"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type AuthStatus = "checking" | "success" | "error" | "idle";

type User = {
  email?: string;
  name?: string;
  picture?: string;
};

export default function SignInPage() {
  const [loading, setLoading] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("idle");
  const [user, setUser] = useState<User | null>(null);
  const [logoutStatus, setLogoutStatus] = useState<"success" | "error" | null>(
    null
  );

  const BACKEND_BASE_URL = useMemo(
    () => process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001",
    []
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");

    if (error) {
      setAuthStatus("error");
      return;
    }

    const checkSession = async () => {
      setAuthStatus("checking");
      try {
        const res = await fetch(`${BACKEND_BASE_URL}/me`, {
          method: "GET",
          credentials: "include",
        });

        if (!res.ok) {
          setAuthStatus("idle");
          return;
        }

        const data = (await res.json()) as User;
        setUser(data);
        setAuthStatus("success");
      } catch {
        setAuthStatus("error");
      }
    };

    checkSession();
  }, [BACKEND_BASE_URL]);

  const handleGoogleSignIn = () => {
    setLoading(true);
    setLogoutStatus(null);

    const next = `${window.location.origin}/dashboard`;
    const url = new URL("/auth/google/start", BACKEND_BASE_URL);
    url.searchParams.set("next", next);

    window.location.href = url.toString();
  };

  const handleLogout = async () => {
    try {
      setLogoutStatus(null);
      const res = await fetch(`${BACKEND_BASE_URL}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) {
        setLogoutStatus("error");
        return;
      }

      setUser(null);
      setAuthStatus("idle");
      setLogoutStatus("success");
    } catch {
      setLogoutStatus("error");
    }
  };

  return (
    <main className="min-h-screen bg-linear-to-br from-[#050712] via-[#0d1124] to-[#131a38] text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-12 px-6 py-14 lg:flex-row lg:items-center">
        

        <div className="w-full max-w-md space-y-5 rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl shadow-indigo-900/40 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-blue-100/70">
                Sign in
              </p>
              <h2 className="text-xl font-semibold text-white">WealthWise access</h2>
            </div>
            <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-100">
              Encrypted
            </span>
          </div>

          <p className="text-sm text-blue-100/80">
            Use your Google account to connect. We store session cookies securely so you
            can upload CSVs and run risk analysis in the dashboard.
          </p>

          <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-br from-indigo-500/40 to-fuchsia-500/30 text-lg font-semibold text-white">
                G
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Google sign in</p>
                <p className="text-xs text-blue-100/70">Redirects to the OAuth flow.</p>
              </div>
            </div>
            <button
              onClick={handleGoogleSignIn}
              disabled={loading || authStatus === "checking"}
              className="w-full rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/20 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Redirecting..." : "Continue with Google"}
            </button>
          </div>

          {authStatus === "success" && (
            <div className="space-y-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-emerald-100">
              <div className="flex items-center gap-3">
                {user?.picture && (
                  <img
                    src={user.picture}
                    alt={user.name ?? "User avatar"}
                    className="h-10 w-10 rounded-full border border-white/10 object-cover"
                  />
                )}
                <div>
                  <p className="text-sm font-semibold text-white">
                    {user?.name ?? "Signed in"}
                  </p>
                  <p className="text-xs text-emerald-100/80">{user?.email}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/dashboard"
                  className="rounded-lg bg-white px-4 py-2 text-xs font-semibold text-[#0d1124] transition hover:-translate-y-px hover:shadow"
                >
                  Continue to dashboard
                </Link>
                <button
                  onClick={handleLogout}
                  className="rounded-lg border border-white/30 px-4 py-2 text-xs font-semibold text-emerald-50 transition hover:border-white/50"
                >
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
