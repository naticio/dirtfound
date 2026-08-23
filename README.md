# Texas Parcel Ownership Map

Interactive map of **13.5 million Texas parcels**, colored by owner location.
Zoomed out, a county choropleth shows the share of out-of-state ownership;
zoom past level 10 and it cross-fades into individual parcels
(blue = Texas owner, orange = out-of-state, gray = unknown), each clickable
for owner names, tax accounts, address, and market value.

A vanilla JS + Cloudflare implementation of the workflow from
[Kyle Walker's "How to visualize millions of parcels on a map"](https://walker-data.com/posts/millions-of-parcels).

**Stack:** plain HTML/CSS/JS (no framework, no build step) · MapLibre GL JS ·
PMTiles · Cloudflare Workers (backend) · Cloudflare R2 (tile storage).

## Run it locally

The demo config points at a publicly hosted tileset, so any static server works:

```sh
cd texas-parcel-map
python3 -m http.server 8080 --directory public
# open http://localhost:8080
```

Or with the full Cloudflare stack (Worker + assets):

```sh
npx wrangler dev
```

## Deploy to Cloudflare

```sh
npx wrangler deploy
```

That publishes the frontend on Workers' static assets and the Worker backend.
To serve tiles from **your own** R2 bucket instead of the demo URL:

1. Build/obtain a `tx_parcels.pmtiles` archive — see [`pipeline/README.md`](pipeline/README.md).
2. `npx wrangler r2 bucket create parcel-data` and upload the archive.
3. In `public/config.js`, set `tilesUrl: "/tiles/tx_parcels.pmtiles"`.
4. `npx wrangler deploy` again.

The Worker (`worker/index.js`) proxies `/tiles/<file>` to R2 with the HTTP
range requests PMTiles needs, CORS headers, and per-range edge caching — no
public bucket or bucket CORS policy required, and R2 has zero egress fees.

## Project layout

```
public/                  # the whole frontend — vanilla JS
  index.html
  app.js                 # map, layers, popups, hover, zoom-driven legends
  config.js              # tile URL, basemap, initial view
  styles.css
  data/tx_counties.geojson   # 254 counties + precomputed ownership stats
worker/index.js          # Cloudflare Worker: static assets + R2 tile server
wrangler.toml
pipeline/                # DuckDB + Tippecanoe scripts to rebuild the data
```

## Credits

- Parcel data: [TxGIO 2025 Statewide Land Parcels](https://tnris.org/stratmap/land-parcels/)
- Workflow & demo tileset: [Kyle Walker](https://walker-data.com/posts/millions-of-parcels)
  — swap in your own tiles before heavy/production use
- Basemap: [OpenFreeMap](https://openfreemap.org) (Positron) © OpenStreetMap contributors
