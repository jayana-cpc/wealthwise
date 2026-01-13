"use client";

import { useMemo, useState } from "react";

export default function Page() {
  const [loading, setLoading] = useState(false);

  // Change this if your backend runs on a different port
  const BACKEND_BASE_URL = useMemo(
    () => process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001",
    []
  );

  const handleGoogleSignIn = async () => {
    try {
      setLoading(true);

      // Where your backend should send the user after OAuth completes:
      // (create this route later, e.g. /dashboard)
      const next = `${window.location.origin}/dashboard`;

      // Your backend should start the OAuth flow and eventually redirect back.
      // Use `next` so backend knows where to return the user after callback.
      const url = new URL("/auth/google/start", BACKEND_BASE_URL);
      url.searchParams.set("next", next);

      // Full-page redirect is the simplest for OAuth flows
      window.location.href = url.toString();
    } finally {
      // In practice, the redirect happens immediately.
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold">Wealthwise</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Sign in to upload your holdings and view risk metrics.
        </p>

        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="mt-6 w-full rounded-xl border border-zinc-300 px-4 py-2 font-medium hover:bg-zinc-50 disabled:opacity-60"
        >
          {loading ? "Redirecting..." : "Sign in with Google"}
        </button>

        <p className="mt-4 text-xs text-zinc-500">
          Dev note: expects backend OAuth start route at{" "}
          <span className="font-mono">{BACKEND_BASE_URL}/auth/google/start</span>
        </p>
      </div>
    </main>
  );
}
