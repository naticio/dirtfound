/**
 * dirtfound-transcriber — standalone Cloudflare Worker for transcribing our
 * own RE (real estate) videos with Groq's Whisper API.
 *
 * Groq's /audio/transcriptions endpoint is a single synchronous call (no
 * queue/webhook needed), so this is simpler than crayo's fal.ai-based
 * pipeline: upload a file, get a transcript back in the same request.
 * KV is used only as a transcript archive so past results can be revisited.
 *
 * Fully separate deployment — own KV namespace, own worker. Does not read
 * or write anything belonging to the crayo backend.
 *
 * Flow:
 *   1. POST /api/transcribe  (multipart "file")  -> { id, text, segments } [Groq, synchronous]
 *   2. GET  /api/transcript?id=...                -> stored transcript (archive lookup)
 *   3. GET  /api/transcripts                       -> recent transcript list
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GROQ_MODEL = "whisper-large-v3-turbo";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/transcribe" && request.method === "POST") return transcribe(env, request);
      if (path === "/api/transcript" && request.method === "GET") return getTranscript(env, url);
      if (path === "/api/transcripts" && request.method === "GET") return listTranscripts(env);

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error.message || "Internal error" }, 500);
    }
  },
};

/* ── Transcribe: browser -> this worker -> Groq (synchronous) ── */

async function transcribe(env, request) {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!file) return json({ error: "Missing file in form data" }, 400);
  if (file.size === 0) return json({ error: "File is empty" }, 400);

  // Groq's free-tier request size cap is 25MB. Long RE walkthrough videos
  // can exceed that — extract audio-only client-side first if you hit this.
  const groqForm = new FormData();
  groqForm.append("file", file, file.name || "upload");
  groqForm.append("model", GROQ_MODEL);
  groqForm.append("response_format", "verbose_json");
  groqForm.append("timestamp_granularities[]", "segment");

  const groqResp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: groqForm,
  });
  if (!groqResp.ok) return json({ error: await groqResp.text() }, 502);
  const data = await groqResp.json();

  const segments = (data.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: (s.text || "").trim(),
  }));
  const text = (data.text || "").trim() || segments.map((s) => s.text).join(" ");

  const id = crypto.randomUUID();
  const record = {
    id,
    title: file.name || "untitled",
    createdAt: Date.now(),
    text,
    segments,
  };
  await kvPut(env, `transcript:${id}`, record);
  await indexTranscript(env, id, record.title, record.createdAt);

  return json(record);
}

/* ── Archive lookups ── */

async function getTranscript(env, url) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id" }, 400);
  const record = await kvGet(env, `transcript:${id}`);
  if (!record) return json({ error: "Not found" }, 404);
  return json(record);
}

async function listTranscripts(env) {
  const list = await env.TRANSCRIPT_JOBS.list({ prefix: "idx:", limit: 100 });
  const entries = await Promise.all(list.keys.map((k) => kvGet(env, k.name)));
  const sorted = entries.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  return json({ transcripts: sorted });
}

async function indexTranscript(env, id, title, createdAt) {
  await kvPut(env, `idx:${createdAt}:${id}`, { id, title, createdAt });
}

/* ── Helpers ── */

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
  });
}

async function kvGet(env, key) {
  const raw = await env.TRANSCRIPT_JOBS.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function kvPut(env, key, value) {
  await env.TRANSCRIPT_JOBS.put(key, JSON.stringify(value));
}
