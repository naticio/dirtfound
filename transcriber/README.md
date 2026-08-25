# RE Video Transcriber

Standalone Cloudflare Worker for transcribing our own real-estate videos,
using Groq's Whisper API (`whisper-large-v3-turbo`) — a single synchronous
call, no queue/webhook needed. Fully separate deployment from crayo — own
KV namespace, own worker name. Nothing here touches crayo's infra.

## Setup

```sh
cd transcriber
npx wrangler kv namespace create TRANSCRIPT_JOBS
# paste the returned id into wrangler.toml's [[kv_namespaces]] id field

npx wrangler secret put GROQ_API_KEY
# paste your Groq API key (console.groq.com/keys)

npx wrangler deploy
```

## Use

Open the deployed worker's URL, upload a video/audio file, get back a
timestamped transcript. Past transcripts are listed below the upload form
(stored in KV, keyed by upload time).

Note: Groq's free-tier request size cap is 25MB — long video files may
exceed that. If you hit the limit, extract audio-only before uploading.

## API

- `POST /api/transcribe` — multipart `file` field → `{ id, title, text, segments }`
- `GET /api/transcript?id=...` → a stored transcript
- `GET /api/transcripts` → recent transcript list
