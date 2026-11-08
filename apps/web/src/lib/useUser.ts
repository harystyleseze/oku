"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type User } from "./api";

/** The signed-in user, or null. `loading` is true until the first check finishes. */
export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: User | null }>("/auth/me");
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  return { user, loading, refresh, logout };
}
