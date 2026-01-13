"use client";

import { useEffect, useMemo, useState } from "react";

type AuthStatus = "checking" | "success" | "error" | "idle";

type User = {
  email?: string;
  name?: string;
  picture?: string;
};

export default function Page() {
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

  // On page load: if redirected back here, verify session by calling /me
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
          credentials: "include", // send cookies
        });

        if (!res.ok) {
          setAuthStatus("idle"); // not logged in (yet)
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

    // Send them back to your frontend after OAuth completes
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
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl text-zinc-700 font-semibold">Wealthwise</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Sign in to upload your holdings and view risk metrics.
        </p>

        <button
          onClick={handleGoogleSignIn}
          disabled={loading || authStatus === "checking"}
          className="mt-6 w-full rounded-xl border border-zinc-300 px-4 py-2 text-zinc-600 font-medium hover:bg-zinc-50 disabled:opacity-60"
        >
          {loading ? "Redirecting..." : "Sign in with Google"}
        </button>

        {authStatus === "success" && (
          <button
            onClick={handleLogout}
            className="mt-3 w-full rounded-xl border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Sign out
          </button>
        )}

        {authStatus !== "idle" && (
          <div
            className={`mt-3 rounded-lg px-3 py-2 text-xs font-medium ${
              authStatus === "success"
                ? "bg-emerald-50 text-emerald-700"
                : authStatus === "error"
                ? "bg-rose-50 text-rose-700"
                : "bg-zinc-50 text-zinc-700"
            }`}
          >
            {authStatus === "checking" && "Checking session..."}
            {authStatus === "success" &&
              `Login successful${user?.email ? ` — ${user.email}` : ""}.`}
            {authStatus === "error" && "Login failed. Please try again."}
          </div>
        )}

        {logoutStatus && (
          <div
            className={`mt-3 rounded-lg px-3 py-2 text-xs font-medium ${
              logoutStatus === "success"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-rose-50 text-rose-700"
            }`}
          >
            {logoutStatus === "success"
              ? "Signed out."
              : "Sign out failed. Please try again."}
          </div>
        )}

        {authStatus === "success" && (
          <a
            href="/dashboard"
            className="mt-4 block w-full rounded-xl bg-black px-4 py-2 text-center text-sm font-semibold text-white hover:opacity-90"
          >
            Continue to dashboard
          </a>
        )}
      </div>
    </main>
  );
}
