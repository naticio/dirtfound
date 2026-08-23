(function () {
  "use strict";

  const cfg = window.APP_CONFIG;

  // Allow ?tiles=<url> to test an alternative tileset without editing config.js
  const tilesOverride = new URLSearchParams(location.search).get("tiles");
  if (tilesOverride) cfg.tilesUrl = tilesOverride;

  // The pmtiles protocol needs an absolute URL — resolve "/tiles/x.pmtiles" etc.
  cfg.tilesUrl = new URL(cfg.tilesUrl, location.href).href;

  // Serve tiles straight out of the .pmtiles archive with HTTP range requests.
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  // owner_status (v2 tiles) with owner_origin (v1/statewide tiles) fallback.
  const STATUS_EXPR = ["coalesce", ["get", "owner_status"], ["get", "owner_origin"], "Unknown"];
  const STATUS_COLOR = [
    "match", STATUS_EXPR,
    "Out-of-state", "#dc2626",
    "Out-of-state owner", "#dc2626",
    "Absentee (TX)", "#ea580c",
    "Local", "#3b5bdb",
    "Texas owner", "#3b5bdb",
    "#94a3b8",
  ];
  const ABSENTEE_FILTER = [
    "in", STATUS_EXPR,
    ["literal", ["Out-of-state", "Out-of-state owner", "Absentee (TX)"]],
  ];

  const map = new maplibregl.Map({
    container: "map",
    style: cfg.basemapStyle,
    center: cfg.center,
    zoom: cfg.zoom,
    hash: true,
    attributionControl: false,
  });

  map.on("error", (e) => console.error("map error:", e && e.error));

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

  map.on("load", () => {
    const z = cfg.handoffZoom; // counties fade out between z and z+1

    map.addSource("parcel-tiles", {
      type: "vector",
      url: "pmtiles://" + cfg.tilesUrl,
    });

    map.addSource("counties", {
      type: "geojson",
      data: cfg.countiesUrl,
    });

    map.addLayer({
      id: "parcels",
      type: "fill",
      source: "parcel-tiles",
      "source-layer": cfg.tilesLayer,
      paint: {
        "fill-color": STATUS_COLOR,
        "fill-opacity": [
          "case", ["boolean", ["feature-state", "hover"], false],
          0.9,
          0.5,
        ],
      },
    });

    const absenteeToggle = document.getElementById("absentee-only");
    absenteeToggle.addEventListener("change", () => {
      map.setFilter("parcels", absenteeToggle.checked ? ABSENTEE_FILTER : null);
    });

    map.addLayer({
      id: "counties-fill",
      type: "fill",
      source: "counties",
      maxzoom: z + 1,
      paint: {
        "fill-color": [
          "case",
          ["==", ["get", "pct_out_of_state"], null], "#e5e7eb",
          ["interpolate", ["linear"], ["get", "pct_out_of_state"],
            0, "#fff7ed",
            40, "#7c2d12"],
        ],
        // Fade counties away as parcels come into view.
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], z, 0.85, z + 1, 0],
      },
    });

    map.addLayer({
      id: "county-borders",
      type: "line",
      source: "counties",
      maxzoom: z + 1,
      paint: {
        "line-color": "#7c2d12",
        "line-width": 0.5,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], z, 0.6, z + 1, 0],
      },
    });

    wirePopups();
    wireHover();
    wireLegends();
  });

  // ---- Popups ----------------------------------------------------------

  const fmtInt = new Intl.NumberFormat("en-US");
  const fmtUSD = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const blank = (v) => v === undefined || v === null || String(v).trim() === "";

  const STATUS_LABELS = {
    "Out-of-state": "🔴 Absentee — out-of-state owner",
    "Out-of-state owner": "🔴 Out-of-state owner",
    "Absentee (TX)": "🟠 Absentee — Texas owner, different ZIP",
    "Local": "🔵 Local owner (mail ZIP matches)",
    "Texas owner": "🔵 Texas owner",
  };

  function parcelPopupHTML(p) {
    const lines = [];
    lines.push(`<strong>${blank(p.owner_names) ? "Owner not listed" : esc(p.owner_names)}</strong>`);
    const status = p.owner_status || p.owner_origin;
    if (STATUS_LABELS[status]) lines.push(STATUS_LABELS[status]);
    lines.push(`Owners: ${p.n_owners ?? "?"} | Tax accounts: ${p.accounts ?? "?"}`);
    if (!blank(p.situs_addr)) lines.push(esc(p.situs_addr));
    else if (!blank(p.situs_zip)) lines.push(`Property ZIP: ${esc(p.situs_zip)}`);
    if (!blank(p.mail_addr)) {
      lines.push(`Mail to: ${esc(p.mail_addr)}${blank(p.owner_location) ? "" : ", " + esc(p.owner_location)}`);
    } else {
      lines.push(`Owner location: ${blank(p.owner_location) ? "Not listed" : esc(p.owner_location)}`);
    }
    if (!blank(p.county)) lines.push(`${esc(p.county)} County`);
    lines.push(blank(p.total_value)
      ? "No market value reported"
      : `Total value: ${fmtUSD.format(p.total_value)}`);
    return lines.join("<br>");
  }

  function countyPopupHTML(p) {
    const pct = blank(p.pct_out_of_state) ? "n/a" : p.pct_out_of_state + "%";
    return [
      `<strong>${esc(p.NAME)} County</strong>`,
      `Parcel records: ${blank(p.parcel_records) ? "n/a" : fmtInt.format(p.parcel_records)}`,
      `Unique owners: ${blank(p.unique_owners) ? "n/a" : fmtInt.format(p.unique_owners)}`,
      `Out-of-state owners: ${pct}`,
    ].join("<br>");
  }

  function wirePopups() {
    map.on("click", (e) => {
      // Prefer a parcel hit; fall back to the county layer when zoomed out.
      const parcels = map.queryRenderedFeatures(e.point, { layers: ["parcels"] });
      let html = null;
      if (parcels.length) {
        html = parcelPopupHTML(parcels[0].properties);
      } else {
        const counties = map.queryRenderedFeatures(e.point, { layers: ["counties-fill"] });
        if (counties.length) html = countyPopupHTML(counties[0].properties);
      }
      if (html) {
        new maplibregl.Popup({ maxWidth: "320px" })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      }
    });
  }

  // ---- Hover highlight -------------------------------------------------

  function wireHover() {
    let hovered = null;

    const clear = () => {
      if (hovered !== null) {
        map.setFeatureState(
          { source: "parcel-tiles", sourceLayer: cfg.tilesLayer, id: hovered },
          { hover: false }
        );
        hovered = null;
      }
    };

    map.on("mousemove", (e) => {
      const feats = map.queryRenderedFeatures(e.point, {
        layers: ["parcels", "counties-fill"],
      });
      map.getCanvas().style.cursor = feats.length ? "pointer" : "";

      const parcel = feats.find((f) => f.layer.id === "parcels");
      // Feature-state hover only works when tiles carry feature ids.
      if (parcel && parcel.id !== undefined) {
        if (parcel.id !== hovered) {
          clear();
          hovered = parcel.id;
          map.setFeatureState(
            { source: "parcel-tiles", sourceLayer: cfg.tilesLayer, id: hovered },
            { hover: true }
          );
        }
      } else {
        clear();
      }
    });

    map.on("mouseout", clear);
  }

  // ---- Zoom-dependent legends -----------------------------------------

  function wireLegends() {
    const countiesLegend = document.getElementById("legend-counties");
    const parcelsLegend = document.getElementById("legend-parcels");

    const update = () => {
      const parcelView = map.getZoom() >= cfg.handoffZoom;
      countiesLegend.classList.toggle("hidden", parcelView);
      parcelsLegend.classList.toggle("hidden", !parcelView);
    };

    map.on("zoom", update);
    update();
  }
})();
