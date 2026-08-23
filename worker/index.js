/**
 * Cloudflare Worker backend.
 *
 * - Serves the static frontend from ./public via the assets binding.
 * - Serves PMTiles archives from an R2 bucket at /tiles/<file>, with the
 *   HTTP range-request support the pmtiles client depends on, CORS headers,
 *   and edge caching of individual byte ranges.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "range, if-match",
  "Access-Control-Expose-Headers": "etag, content-range, content-length, accept-ranges",
  "Access-Control-Max-Age": "3600",
};

const CACHE_TTL_SECONDS = 86400; // tiles are immutable-ish; bump the filename to bust

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/tiles/")) {
      return handleTiles(request, env, ctx, url);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleTiles(request, env, ctx, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(new Response("Method not allowed", { status: 405 }));
  }

  const key = decodeURIComponent(url.pathname.slice("/tiles/".length));
  if (!key || key.includes("..")) {
    return withCors(new Response("Bad request", { status: 400 }));
  }

  const range = parseRange(request.headers.get("Range"));

  // Cache each byte range as its own edge-cache entry (the Cache API does not
  // vary on the Range header, so the range is encoded into the cache key).
  const cache = caches.default;
  const cacheKey = new Request(
    `${url.origin}/tiles/${key}?r=${range ? `${range.offset}-${range.length}` : "full"}`,
    { method: "GET" }
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    return request.method === "HEAD"
      ? new Response(null, { status: cached.status, headers: cached.headers })
      : cached;
  }

  const object = await env.TILES.get(key, range ? { range } : undefined);
  if (object === null) {
    return withCors(new Response("Not found", { status: 404 }));
  }

  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}`);

  let status = 200;
  if (range) {
    status = 206;
    const end = Math.min(range.offset + range.length, object.size) - 1;
    headers.set("Content-Range", `bytes ${range.offset}-${end}/${object.size}`);
    headers.set("Content-Length", String(end - range.offset + 1));
  } else {
    headers.set("Content-Length", String(object.size));
  }

  const response = new Response(object.body, { status, headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return request.method === "HEAD"
    ? new Response(null, { status, headers })
    : response;
}

function parseRange(header) {
  // Supports the single-range form the pmtiles client sends: "bytes=start-end".
  const m = header && header.match(/^bytes=(\d+)-(\d+)?$/);
  if (!m) return null;
  const offset = Number(m[1]);
  if (m[2] === undefined) return { offset }; // open-ended: R2 reads to EOF
  const length = Number(m[2]) - offset + 1;
  return length > 0 ? { offset, length } : null;
}

function withCors(response) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
  return response;
}
