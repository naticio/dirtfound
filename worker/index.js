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
    if (url.pathname === "/api/violations") {
      return handleViolations(request, ctx, url);
    }
    if (url.pathname === "/api/taxsales") {
      return handleTaxSales(request, ctx, url);
    }
    if (url.pathname === "/api/search") {
      return handleSearch(request, env, url);
    }
    if (url.pathname === "/api/deals") {
      return handleDeals(request, env, ctx, url);
    }
    if (url.pathname === "/api/checkout") {
      return handleCheckout(request, env, url);
    }
    if (url.pathname === "/api/activate") {
      return handleActivate(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};

// Open code-enforcement cases (Austin + Dallas open data portals),
// merged into one GeoJSON and edge-cached for 6 hours.
const AUSTIN_URL =
  "https://data.austintexas.gov/resource/6wtj-zbtb.json" +
  "?$where=" + encodeURIComponent("status != 'Closed' AND latitude IS NOT NULL") +
  "&$select=" + encodeURIComponent("case_id,status,address,zip_code,opened_date,description,latitude,longitude") +
  "&$limit=25000";

const DALLAS_URL =
  "https://www.dallasopendata.com/resource/d7e7-envw.json" +
  "?$where=" + encodeURIComponent(
    "department = 'Code Compliance' AND status in('In Progress','New','Escalated') AND lat_location IS NOT NULL") +
  "&$select=" + encodeURIComponent(
    "service_request_number,service_request_type,status,address,created_date,lat_location") +
  "&$limit=25000";

async function handleViolations(request, ctx, url) {
  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/api/violations", { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [austinRes, dallasRes] = await Promise.all([
    fetch(AUSTIN_URL, { headers: { Accept: "application/json" } }),
    fetch(DALLAS_URL, { headers: { Accept: "application/json" } }),
  ]);
  if (!austinRes.ok && !dallasRes.ok) {
    return withCors(new Response("Upstream error", { status: 502 }));
  }

  const features = [];

  if (austinRes.ok) {
    for (const r of await austinRes.json()) {
      const lon = Number(r.longitude), lat = Number(r.latitude);
      if (!isFinite(lon) || !isFinite(lat)) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          id: r.case_id,
          status: r.status,
          address: r.address || "",
          zip: r.zip_code || "",
          opened: (r.opened_date || "").slice(0, 10),
          desc: r.description || "",
          city: "Austin",
        },
      });
    }
  }

  if (dallasRes.ok) {
    for (const r of await dallasRes.json()) {
      // lat_location looks like "(32.840477,-96.681035)"
      const m = /\((-?[\d.]+),(-?[\d.]+)\)/.exec(r.lat_location || "");
      if (!m) continue;
      const lat = Number(m[1]), lon = Number(m[2]);
      if (!isFinite(lon) || !isFinite(lat) || lat < 32 || lat > 33.5) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          id: r.service_request_number,
          status: r.status,
          address: r.address || "",
          zip: "",
          opened: (r.created_date || "").slice(0, 10),
          desc: r.service_request_type || "",
          city: "Dallas",
        },
      });
    }
  }

  const response = new Response(
    JSON.stringify({ type: "FeatureCollection", features }),
    {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600",
      },
    }
  );
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ---- DirtFound Pro paywall (Stripe subscription + signed access tokens) ----

const PRICE_ID = "price_1U8Ck38mY0qSfHMDyzoDL02W"; // DirtFound Pro, $29/mo
const TOKEN_TTL_S = 30 * 24 * 3600; // re-verified against Stripe on expiry

const json = (obj, status = 200) =>
  withCors(new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  }));

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw",
    new TextEncoder().encode(env.SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeToken(env, subId) {
  const payload = `${subId}.${Math.floor(Date.now() / 1000) + TOKEN_TTL_S}`;
  return `${payload}.${await hmac(env, payload)}`;
}

// Returns the subscription id if the token is valid and unexpired, else null.
async function checkToken(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [subId, exp, sig] = parts;
  if (Number(exp) < Date.now() / 1000) return null;
  return (await hmac(env, `${subId}.${exp}`)) === sig ? subId : null;
}

async function stripeAPI(env, method, path, form) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  return { ok: res.ok, data: await res.json() };
}

async function handleCheckout(request, env, url) {
  const { ok, data } = await stripeAPI(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: `${url.origin}/?checkout={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/`,
    allow_promotion_codes: "true",
    // 100%-off promo codes (e.g. founder code) check out without a card.
    payment_method_collection: "if_required",
  });
  if (!ok) return json({ error: data.error?.message || "checkout failed" }, 502);
  return json({ url: data.url });
}

async function handleActivate(request, env, url) {
  const sessionId = url.searchParams.get("session_id") || "";
  // Renewal path: an expired-but-authentic token re-verifies its subscription.
  const renew = url.searchParams.get("renew") || "";
  let subId = null;
  if (sessionId.startsWith("cs_")) {
    const { ok, data } = await stripeAPI(env, "GET",
      `/checkout/sessions/${encodeURIComponent(sessionId)}`);
    const paid = ["paid", "no_payment_required"].includes(data.payment_status);
    if (!ok || !paid || !data.subscription) {
      return json({ error: "payment not completed" }, 402);
    }
    subId = data.subscription;
  } else if (renew) {
    const parts = renew.split(".");
    if (parts.length === 3 && (await hmac(env, `${parts[0]}.${parts[1]}`)) === parts[2]) {
      subId = parts[0]; // signature valid; expiry ignored — Stripe decides below
    }
  }
  if (!subId) return json({ error: "invalid request" }, 400);
  const { ok, data } = await stripeAPI(env, "GET",
    `/subscriptions/${encodeURIComponent(subId)}`);
  if (!ok || !["active", "trialing", "past_due"].includes(data.status)) {
    return json({ error: "subscription inactive" }, 402);
  }
  return json({ token: await makeToken(env, subId) });
}

// Deal sheet: every Dallas/Travis tax-foreclosure property joined against the
// parcel owner database by address, so each row is call-ready. Cached 12h.
// Requires a DirtFound Pro token (see paywall above).
async function handleDeals(request, env, ctx, url) {
  const auth = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(await checkToken(env, auth))) {
    return json({ error: "subscription required" }, 402);
  }
  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/api/deals", { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const salesRes = await handleTaxSales(request, ctx, new URL(url.origin + "/api/taxsales"));
  if (!salesRes.ok) return withCors(new Response("Upstream error", { status: 502 }));
  const sales = (await salesRes.json()).features.filter((f) =>
    f.properties.county === "DALLAS COUNTY" || f.properties.county === "TRAVIS COUNTY");

  // FTS query from the street part of the address: '"4240" "ARMSTRONG" "PKWY"'
  const ftsQuery = (addr) => {
    const street = String(addr || "").split(",")[0]
      .replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 5);
    return street.length >= 2 ? street.map((t) => `"${t}"`).join(" ") : null;
  };

  const deals = [];
  for (let i = 0; i < sales.length; i += 80) {
    const chunk = sales.slice(i, i + 80);
    const stmts = chunk.map((f) => {
      const q = ftsQuery(f.properties.address);
      return env.OWNERS.prepare(
        q
          ? `SELECT o.name, o.addr, o.value FROM owners_fts f JOIN owners o ON o.id = f.rowid
             WHERE owners_fts MATCH ? LIMIT 1`
          : `SELECT NULL AS name, NULL AS addr, NULL AS value LIMIT 0`
      ).bind(...(q ? [q] : []));
    });
    const results = await env.OWNERS.batch(stmts);
    chunk.forEach((f, j) => {
      const p = f.properties;
      const owner = (results[j].results || [])[0] || {};
      deals.push({
        address: p.address, county: p.county, type: p.type, status: p.status,
        sale_date: p.sale_date, min_bid: p.min_bid, value: p.value || owner.value || null,
        account: p.account, cause: p.cause,
        lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
        owner: owner.name || null, owner_parcel_value: owner.value || null,
      });
    });
  }
  // Real spreads (bid + value known) rank first; date-less future sales follow by value.
  const rank = (d) => (d.min_bid && d.value)
    ? 1e12 + (d.value - d.min_bid)
    : (d.value || 0);
  deals.sort((a, b) => rank(b) - rank(a));

  const response = new Response(JSON.stringify({ deals }), {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=43200",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// Owner-name search over all parcels (D1 + FTS5). Word-prefix matching:
// "nativ smith" finds names containing a word starting with each term.
async function handleSearch(request, env, url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) {
    return withCors(new Response(JSON.stringify({ results: [] }), {
      headers: { "Content-Type": "application/json" },
    }));
  }
  // Build an FTS5 query: quoted word prefixes, AND-ed. Strip FTS metacharacters.
  const terms = q.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) {
    return withCors(new Response(JSON.stringify({ results: [] }), {
      headers: { "Content-Type": "application/json" },
    }));
  }
  const match = terms.map((t) => `"${t}"*`).join(" ");
  const stmt = env.OWNERS.prepare(
    `SELECT o.name, o.status, o.addr, o.county, o.value, o.lon, o.lat
     FROM owners_fts f JOIN owners o ON o.id = f.rowid
     WHERE owners_fts MATCH ? LIMIT 500`
  ).bind(match);
  const { results } = await stmt.all();
  return withCors(new Response(JSON.stringify({ results }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  }));
}

// Texas tax-foreclosure sale properties from LGBS (the delinquent-tax law firm
// for most TX counties), paged into one GeoJSON and edge-cached for 12 hours.
const LGBS_PAGE = (offset) =>
  `https://taxsales.lgbs.com/api/property_sales/?state=TX&limit=1000&offset=${offset}`;

async function handleTaxSales(request, ctx, url) {
  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/api/taxsales", { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const features = [];
  for (let offset = 0; offset < 12000; offset += 1000) {
    const res = await fetch(LGBS_PAGE(offset), {
      headers: { Accept: "application/json", "User-Agent": "dirtfound.com data layer" },
    });
    if (!res.ok) break;
    const page = await res.json();
    for (const r of page.results || []) {
      const coords = r.geometry && r.geometry.coordinates;
      if (!coords || !isFinite(coords[0]) || !isFinite(coords[1])) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [coords[0], coords[1]] },
        properties: {
          id: r.uid,
          type: r.sale_type || "",
          status: r.status || "",
          sale_date: r.sale_date_only || "",
          min_bid: Number(r.minimum_bid) || null,
          value: Number(r.value) || null,
          address: [r.prop_address_one, r.prop_city, r.prop_zipcode]
            .filter(Boolean).join(", "),
          county: r.county || "",
          account: r.account_nbr || "",
          cause: r.cause_nbr || "",
        },
      });
    }
    if (!page.next) break;
  }

  if (!features.length) {
    return withCors(new Response("Upstream error", { status: 502 }));
  }

  const response = new Response(
    JSON.stringify({ type: "FeatureCollection", features }),
    {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=43200",
      },
    }
  );
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

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
