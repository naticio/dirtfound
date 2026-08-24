// App configuration. Edit these values to point the map at your own data.
window.APP_CONFIG = {
  // PMTiles vector tileset of parcels (see pipeline/README.md to build your own).
  //
  // Default: Kyle Walker's publicly hosted Texas parcels tileset (demo only —
  // swap in your own before sharing widely).
  //
  // When deployed with the included Cloudflare Worker + R2 bucket, use the
  // Worker route instead so tiles are served from YOUR bucket with edge caching:
  //   tilesUrl: "/tiles/tx_parcels.pmtiles",
  //
  // Your own Travis County tileset (pipeline/work/tx_parcels_travis.pmtiles)
  // can be tested without editing this file: append
  //   ?tiles=http://localhost:8002/tx_parcels_travis.pmtiles
  // to the app URL while `npx http-server -p 8002 --cors` runs in pipeline/work.
  // Default: your own Travis + Dallas County tileset served from R2 via the Worker,
  // with owner_status absentee classification.
  // Kyle Walker's statewide demo tileset (owner_origin only, no absentee flags)
  // is still usable via:
  //   ?tiles=https://pub-dab6da17bbca46afa88c433f4727323c.r2.dev/tx_parcels.pmtiles
  // Versioned filename: tile archives are cached at the edge by byte range,
  // so replacing one means publishing under a new name, never overwriting.
  tilesUrl: "/tiles/tx_parcels-4.pmtiles",

  // Name of the layer inside the PMTiles archive.
  tilesLayer: "parcels",

  // County polygons with pre-computed ownership stats (parcel_records,
  // unique_owners, pct_out_of_state). Regenerate with the pipeline.
  countiesUrl: "data/tx_counties.geojson",

  basemapStyle: "https://tiles.openfreemap.org/styles/positron",

  // Initial view: statewide, so the county choropleth tells the story first.
  center: [-99.3, 31.3],
  zoom: 5.2,

  // Zoom at which counties fade out and parcels take over.
  handoffZoom: 10,
};
