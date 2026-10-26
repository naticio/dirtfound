// Mirror the US DOT aviation-noise raster tiles for the metros DirtFound
// covers into public/noise/, so the flight-path layer is served as static
// assets (no Worker invocations, no dependency on geo.dot.gov, which often
// stalls for browsers). Tiles with no noise contours are skipped; the app
// reads public/noise/index.json to know which tiles exist.
//
//   node pipeline/noise_tiles.mjs
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

const run = promisify(execFile);

const SRC = "https://geo.dot.gov/server/rest/services/Hosted/NTAD_Noise_2020_CONUS_Aviation/MapServer/tile";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "noise");
const MINZOOM = 8, MAXZOOM = 12;
// [west, south, east, north]
const AREAS = {
  dfw: [-97.9, 32.3, -96.3, 33.5],
  austin: [-98.2, 29.9, -97.3, 30.7],
};

const tileX = (lng, z) => Math.floor((lng + 180) / 360 * 2 ** z);
const tileY = (lat, z) => {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
};

// Fetched with curl: geo.dot.gov often stalls connections from Node and
// browsers while answering curl instantly.
async function fetchTile(z, y, x) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { stdout } = await run("curl", ["-sf", "--max-time", "20", `${SRC}/${z}/${y}/${x}`],
        { encoding: "buffer", maxBuffer: 1 << 24 });
      return stdout.length ? stdout : null;
    } catch (err) {
      if (err.code === 22) return null; // HTTP error status (missing tile)
      if (attempt === 3) throw new Error(`${z}/${y}/${x}: curl exit ${err.code}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// Decode just enough of the PNG to tell whether any pixel is visible.
function hasVisiblePixels(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) return true; // not PNG (e.g. JPEG) — keep it
  let off = 8, w = 0, h = 0, colorType = 0, depth = 0, palAlpha = null;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; }
    else if (type === "tRNS") palAlpha = data;
    else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  if (depth !== 8) return true;
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (colorType !== 6 && colorType !== 3) return true; // no per-pixel alpha to check
  // Undo scanline filters so alpha values are real.
  const stride = w * bpp, prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let row = 0; row < h; row++) {
    const base = row * (stride + 1), filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i], a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (filter) {
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: v = x;
      }
      cur[i] = v & 255;
    }
    for (let px = 0; px < w; px++) {
      const alpha = colorType === 6 ? cur[px * 4 + 3] : (palAlpha && cur[px] < palAlpha.length ? palAlpha[cur[px]] : 255);
      if (alpha >= 20) return true;
    }
    cur.copy(prev);
  }
  return false;
}

const jobs = [];
for (const z of Array.from({ length: MAXZOOM - MINZOOM + 1 }, (_, i) => MINZOOM + i)) {
  const seen = new Set();
  for (const [w, s, e, n] of Object.values(AREAS)) {
    for (let x = tileX(w, z); x <= tileX(e, z); x++)
      for (let y = tileY(n, z); y <= tileY(s, z); y++) {
        const k = `${z}/${y}/${x}`;
        if (!seen.has(k)) { seen.add(k); jobs.push([z, y, x]); }
      }
  }
}

await rm(OUT, { recursive: true, force: true });
const kept = [];
let next = 0, done = 0;
async function worker() {
  while (next < jobs.length) {
    const [z, y, x] = jobs[next++];
    const png = await fetchTile(z, y, x);
    if (png && hasVisiblePixels(png)) {
      const file = join(OUT, String(z), String(y), `${x}.png`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, png);
      kept.push(`${z}/${y}/${x}`);
    }
    if (++done % 50 === 0) console.log(`${done}/${jobs.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

kept.sort();
await writeFile(join(OUT, "index.json"), JSON.stringify({
  minzoom: MINZOOM, maxzoom: MAXZOOM, areas: AREAS, tiles: kept,
}));
console.log(`${jobs.length} tiles checked, ${kept.length} with noise contours → public/noise/`);
