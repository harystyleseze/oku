"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@/lib/useUser";

export function TopBar() {
  const { user, loading, logout } = useUser();
  const router = useRouter();

  return (
    <header className="shell topbar">
      <Link href="/" className="wordmark" aria-label="Oku home">
        <i aria-hidden /> oku
      </Link>
      <nav className="nav">
        {loading ? null : user ? (
          <>
            <Link href="/dashboard">Conversations</Link>
            <button
              className="btn secondary"
              onClick={async () => {
                await logout();
                router.push("/");
                router.refresh();
              }}
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <Link href="/login">Sign in</Link>
            <Link href="/signup" className="btn">
              Create account
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
