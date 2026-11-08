import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { Waveform } from "@/components/Waveform";
import { demoPeaks } from "@/lib/demoPeaks";

const demoTracks = [
  { color: "#ff7a59", peaks: demoPeaks(7, 480, [[0, 0.22], [0.41, 0.58], [0.86, 1]]) },
  { color: "#4c6fff", peaks: demoPeaks(3, 480, [[0.2, 0.43], [0.56, 0.88]]) },
];

export default function Home() {
  return (
    <>
      <TopBar />
      <main className="shell page" style={{ paddingTop: 48 }}>
        <section className="stack" style={{ gap: 28 }}>
          <h1 style={{ maxWidth: "16ch" }}>Two voices, recorded as themselves.</h1>
          <p style={{ fontSize: "1.15rem", maxWidth: "46ch" }} className="muted">
            Open a room, send the link, talk. Oku records each person on their own track, in full quality, and the
            Studio turns the conversation into clips with a cover that moves to your voices.
          </p>
          <div className="row">
            <Link href="/signup" className="btn large">
              Start a room
            </Link>
            <Link href="/login" className="btn secondary large">
              Sign in
            </Link>
          </div>
        </section>

        <section style={{ marginTop: 56 }} className="panel">
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="row" style={{ gap: 18 }}>
              <span className="row" style={{ gap: 8 }}>
                <span className="dot" style={{ background: "#ff7a59" }} /> Amaka
              </span>
              <span className="row" style={{ gap: 8 }}>
                <span className="dot" style={{ background: "#4c6fff" }} /> Tunde
              </span>
            </div>
            <span className="muted small">48:32</span>
          </div>
          <Waveform tracks={demoTracks} height={150} />
        </section>

        <section
          style={{
            marginTop: 56,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 32,
          }}
        >
          <div className="stack" style={{ gap: 8 }}>
            <h3>Nothing to install</h3>
            <p className="muted">Guests join from a link in any modern browser. Phone or laptop, no account needed.</p>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <h3>Recorded locally, saved continuously</h3>
            <p className="muted">
              Each voice is captured on the speaker&apos;s own device and uploaded as you talk, so a weak connection
              never costs you the conversation.
            </p>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <h3>Clips sized for each platform</h3>
            <p className="muted">
              Trim to the length TikTok, Reels, Shorts or X expect, add a title, and download a video with a waveform
              that follows whoever is speaking.
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
