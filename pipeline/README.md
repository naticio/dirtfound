# Data pipeline: TxGIO parcels → PMTiles on R2

This reproduces the data behind the map without R — just DuckDB and Tippecanoe.
It follows the workflow from [Kyle Walker's post](https://walker-data.com/posts/millions-of-parcels).

The app currently points at Kyle's publicly hosted demo tileset. Run this
pipeline to build and host **your own** copy (or adapt it for another state —
Florida and New York publish similar statewide files).

## Already done: county-scale run (Travis / Austin)

`work/tx_parcels_travis.pmtiles` (43 MB, 382,280 parcels) was built from the
TxGIO **county** download using `work/clean_travis.sql` — the same cleaning
logic at a size that fits a nearly-full disk. Test it locally with:

```sh
npx http-server -p 8002 --cors        # from pipeline/work/
# open the app with ?tiles=http://localhost:8002/tx_parcels_travis.pmtiles
```

Per-county download URLs come from the TxGIO API (CloudFront blocks curl's
default user agent — pass a browser `-A` string when downloading):

```sh
curl -s "https://api.tnris.org/api/v1/resources/?collection_id=0fa04328-872e-481c-b453-126a74777593&area_type_name=Travis"
```

The statewide run below is the same recipe at full scale — it needs roughly
**40 GB of free disk** for the download, intermediates, and tippecanoe temp
files.

## 0. Install tools

```sh
brew install duckdb tippecanoe   # tippecanoe ≥ 2.x builds .pmtiles directly
```

## 1. Download the source data (~2.6 GB zipped, ~7 GB unzipped)

2025 statewide land parcels from the Texas Geographic Information Office
(253 of 254 counties): https://tnris.org/stratmap/land-parcels/

Unzip to get `stratmap25-landparcels_48.gdb`.

## 2. Clean + deduplicate in DuckDB

```sh
duckdb tx_parcels.duckdb < clean_parcels.sql
```

`clean_parcels.sql` does what the blog post does in R:

- drops records with no geometry
- classifies each owner as **Texas owner / Out-of-state owner / Unknown**
  from the mailing state (including the Tarrant County "CITY, TX" quirk)
- collapses "stacked" parcels (repeated geometries — condos, mobile-home
  parks) into one row per unique geometry, keeping owner names, account
  counts, and summed market value
- writes `tx_parcels_tiles.parquet` in EPSG:4326

## 3. Tile to PMTiles

```sh
duckdb -c "COPY (SELECT * FROM 'tx_parcels_tiles.parquet') TO 'tx_parcels.geojsonl' \
  WITH (FORMAT gdal, DRIVER 'GeoJSONSeq');"

tippecanoe -o tx_parcels.pmtiles -l parcels \
  --minimum-zoom=10 --maximum-zoom=14 \
  --detect-shared-borders --coalesce-densest-as-needed \
  --force tx_parcels.geojsonl
```

Parcels are invisible below zoom 10 anyway; z14 is enough detail
(overzooming keeps them sharp past that). Expect a ~4–5 GB archive.

## 4. Upload to your R2 bucket

```sh
npx wrangler r2 bucket create parcel-data
```

`wrangler r2 object put` caps out on multi-GB files, so use any S3 client
with R2's S3 API (endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`,
region `auto`) and an R2 API token scoped to the bucket:

```sh
aws s3 cp tx_parcels.pmtiles s3://parcel-data/tx_parcels.pmtiles \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

No public-bucket setup or CORS policy needed: the Worker in `../worker/`
proxies the bucket at `/tiles/tx_parcels.pmtiles` with range requests,
CORS, and edge caching already handled.

## 5. Regenerate county stats

```sh
duckdb tx_parcels.duckdb < county_stats.sql   # writes county_stats.csv
```

Join the CSV onto county boundaries (Census cartographic boundary file,
`cb_2024_us_county_500k`, filtered to STATEFP 48) and save as
`public/data/tx_counties.geojson` with properties `NAME`, `parcel_records`,
`unique_owners`, `pct_out_of_state`. The repo ships with a pre-built copy.

## 6. Point the app at your tiles

In `public/config.js`:

```js
tilesUrl: "/tiles/tx_parcels.pmtiles",
```
