# Oku

Talk naturally. Oku records every voice in a call on its own track and turns the conversation into clips worth sharing.

This repository holds **the Space** (rooms, invite links, audio calls, per-speaker recording that survives bad connections) and **the Studio** (playback, downloads, trimming to each platform's length, an animated waveform cover exported as MP4, and, when a transcription key is configured, a speaker-exact transcript with burned-in captions). The Network comes later.

## What is in the box

```
apps/
  api/   Node + Express + WebSocket. Auth, rooms, signalling, chunk uploads, ffmpeg processing & exports.
  web/   Next.js. Landing, sign-up, dashboard, the Space (live room) and the Studio.
docker-compose.yml   Postgres (and optional MinIO) for local development.
```

How a conversation flows through the system:

1. **Host creates a room** → gets a permanent link `/r/<slug>`.
2. **People join** with a name and a consent checkbox. Audio goes browser-to-browser over WebRTC (mesh); the API only relays the connection handshake.
3. **Host presses Record.** Every browser records *its own microphone* with `MediaRecorder` in 5-second parts. Each part is written to IndexedDB first, then uploaded. If the network drops, parts queue up and retry; if the tab closes, the next visit finishes the upload.
4. **Host presses Stop.** Each browser finalises its track. When all tracks are in (or 90 s after stop, if someone vanished), the API stitches the parts, aligns the tracks to a shared timeline, transcodes them to AAC, mixes them, and computes waveform peaks.
5. **Studio.** The host plays the mix, downloads the full conversation or any single voice, picks a platform (TikTok, Reels, Shorts, X, YouTube), trims, titles, and exports. ffmpeg renders a video where each speaker has their own coloured wave that moves only when they talk.
6. **Transcript (optional).** With `TRANSCRIPTION_API_KEY` set, each speaker's track is transcribed on its own, so speaker labels are exact without diarisation. Silence is cut out first so the model never sees the long gaps while the other person talks. The Studio shows the transcript by speaker (click a word to jump, "Start here"/"End here" to set a clip, search to find a moment), offers `.txt`/`.srt` downloads, and can burn speaker-coloured captions into clips.

## Run it locally

Prerequisites: Node 20+, ffmpeg (`brew install ffmpeg` / `apt install ffmpeg`), Docker (for Postgres) or any Postgres 14+.

```bash
npm install
docker compose up -d postgres

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

npm run db:migrate        # creates the tables
npm run dev               # API on :4000, web on :3000
```

Open http://localhost:3000, create an account, create a room, and open the room link in a second browser (or an incognito window) to be the guest.

**Transcription** needs an OpenAI-compatible `/audio/transcriptions` endpoint. Set `TRANSCRIPTION_API_KEY` (and, for a provider other than OpenAI, `TRANSCRIPTION_BASE_URL` and `TRANSCRIPTION_MODEL`; Groq's `whisper-large-v3` works and is inexpensive). Without a key everything else works and the Studio says transcription isn't set up. To develop the transcript features without a key, run `node apps/api/scripts/mock-transcriber.mjs` and point `TRANSCRIPTION_BASE_URL` at `http://localhost:4100/v1` with any `TRANSCRIPTION_API_KEY`; it returns placeholder words with real timing.

Recordings are stored under `apps/api/data/` by default. To use an S3-compatible bucket instead, set `STORAGE_DRIVER=s3` and the `S3_*` variables (the compose file includes MinIO if you want to try that locally: `docker compose up -d minio`, then create a bucket named `oku` at http://localhost:9001).

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Both apps with reload |
| `npm run typecheck` | TypeScript across both apps |
| `npm run build` | Production builds |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:generate` | Generate a migration after editing `apps/api/src/schema.ts` |

## Deploying

The two apps deploy independently. Both are plain Node processes.

- **API** needs ffmpeg on the machine and a Postgres database. `apps/api/Dockerfile` builds an image with ffmpeg included. Set `WEB_ORIGIN` to the web app's URL, `COOKIE_SECURE=true`, and use the S3 storage driver so recordings outlive the container.
- **Web** is a standard Next.js app (`apps/web/Dockerfile`, or Vercel/Netlify). Set `NEXT_PUBLIC_API_URL` to the API's public URL.
- Host both under the same parent domain (for example `app.oku.example` and `api.oku.example`). The session cookie is `SameSite=Lax`, which works across subdomains but not across unrelated domains.
- **TURN server.** Browsers behind strict NATs or corporate firewalls cannot connect peer-to-peer with STUN alone. Set `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL` (coturn, Twilio, Cloudflare Calls, or similar) before inviting real users.
- Processing and exports run inside the API process, one job at a time, and resume after a restart. For heavier load, run more than one API instance behind a load balancer only once uploads and jobs are moved to shared infrastructure (S3 is already supported; the in-process queue would need a shared queue).

## Product decisions carried into the code

- **Recording reliability first.** Local capture, continuous upload, IndexedDB buffer, resumable finalisation, and a grace period so a vanished guest never blocks the host.
- **Consent is explicit.** Nobody joins without ticking the consent line; a pulsing indicator shows whenever recording is on; the host owns the recording and can delete it (files and database rows).
- **Natural voices.** Light browser processing only (echo cancellation, noise suppression). No aggressive compression, no silence removal.
- **One signature visual.** The speaker-coloured waveform appears on the landing page, in the live room, in the Studio timeline, and in every export.
- **Audio first,** with video left open: tracks, participants and exports are modelled independently of the media type.

## What is deliberately not here yet

Highlight detection, transcript-based editing, direct publishing to social platforms, creator profiles and discovery. Each has a clear place to plug in (a job kind in `apps/api/src/queue.ts`, a new export parameter, a new table) without reworking what exists.

## Known limits of this build

- Mesh WebRTC is comfortable for 2–5 people. Larger rooms need an SFU.
- Exports use a system font (DejaVu, or whatever `FONT_FILE` points at). Ship a brand font with the API for production covers.
- `npm audit` reports a moderate advisory in `esbuild` pulled in by `drizzle-kit`. It concerns esbuild's own development server, which Oku never runs; it is a build-tool-only dependency.
