"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { api, ApiError, formatDate, formatDuration, type ConversationListItem, type Room } from "@/lib/api";
import { useUser } from "@/lib/useUser";

export default function Dashboard() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, c] = await Promise.all([
      api<{ rooms: Room[] }>("/rooms"),
      api<{ conversations: ConversationListItem[] }>("/conversations"),
    ]);
    setRooms(r.rooms);
    setConversations(c.conversations);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login?next=/dashboard");
      return;
    }
    void load().catch((e) => setError(e.message));
  }, [user, loading, router, load]);

  // Conversations still processing: refresh until they settle.
  useEffect(() => {
    if (!conversations.some((c) => c.status === "processing" || c.status === "recording")) return;
    const t = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [conversations, load]);

  async function createRoom(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ room: Room }>("/rooms", { method: "POST", json: { title } });
      setTitle("");
      router.push(`/r/${r.room.slug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the room.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(slug: string) {
    const url = `${window.location.origin}/r/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(slug);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  if (loading || !user) return <TopBar />;

  return (
    <>
      <TopBar />
      <main className="shell page stack" style={{ gap: 40 }}>
        <section className="stack">
          <h1 style={{ fontSize: "2rem" }}>Hello, {user.displayName.split(" ")[0]}</h1>
          <form className="row" onSubmit={createRoom}>
            <input
              className="input"
              style={{ maxWidth: 360 }}
              placeholder="Name a new room, e.g. Sunday calls"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={80}
              required
            />
            <button className="btn" disabled={busy}>
              Create room
            </button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>

        <section className="stack">
          <div className="row between">
            <h2>Rooms</h2>
            <span className="muted small">A room is a permanent link. Reuse it as often as you like.</span>
          </div>
          {rooms.length === 0 ? (
            <div className="panel muted">No rooms yet. Create one above and share its link to start talking.</div>
          ) : (
            <div className="list">
              {rooms.map((room) => (
                <div key={room.id} className="list-row">
                  <div>
                    <strong>{room.title}</strong>
                    <div className="muted small">
                      {room._count?.conversations ?? 0} recording{room._count?.conversations === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="row">
                    <button className="btn secondary" onClick={() => copyLink(room.slug)}>
                      {copied === room.slug ? "Link copied" : "Copy invite link"}
                    </button>
                    <Link href={`/r/${room.slug}`} className="btn">
                      Enter room
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="stack">
          <h2>Conversations</h2>
          {conversations.length === 0 ? (
            <div className="panel muted">
              Recordings appear here as soon as you stop them. Enter a room and press Record to make the first one.
            </div>
          ) : (
            <div className="list">
              {conversations.map((c) => (
                <Link key={c.id} href={`/c/${c.id}`} className="list-row">
                  <div>
                    <strong>{c.title}</strong>
                    <div className="row muted small" style={{ gap: 10 }}>
                      <span className="speakers">
                        {c.participants.map((p, i) => (
                          <span key={i} className="dot" style={{ background: p.color }} title={p.displayName} />
                        ))}
                        {c.participants.map((p) => p.displayName).join(", ")}
                      </span>
                      <span>{formatDate(c.startedAt)}</span>
                      <span>{formatDuration(c.durationMs)}</span>
                    </div>
                  </div>
                  <span className={`status ${c.status}`}>{statusLabel(c.status)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function statusLabel(s: ConversationListItem["status"]) {
  switch (s) {
    case "recording":
      return "Recording";
    case "processing":
      return "Processing";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}
