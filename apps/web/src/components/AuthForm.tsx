"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

export function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/${mode}`, {
        method: "POST",
        json: mode === "signup" ? { displayName, email, password } : { email, password },
      });
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={submit} style={{ maxWidth: 420, gap: 18 }}>
      <h2>{mode === "signup" ? "Create your account" : "Welcome back"}</h2>
      {mode === "signup" && (
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input
            id="name"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            required
            maxLength={40}
            placeholder="Shown to people you talk with"
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          className="input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          minLength={8}
        />
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn large" disabled={busy}>
        {busy ? "One moment" : mode === "signup" ? "Create account" : "Sign in"}
      </button>
      <p className="muted small">
        {mode === "signup" ? (
          <>
            Already have an account? <Link href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
          </>
        ) : (
          <>
            New here? <Link href={`/signup?next=${encodeURIComponent(next)}`}>Create an account</Link>
          </>
        )}
      </p>
    </form>
  );
}
