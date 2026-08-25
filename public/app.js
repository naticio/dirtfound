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
  // Legacy tilesets use owner_origin labels; map each canonical status to all
  // the labels that should match it when filtering.
  const STATUS_ALIASES = {
    "Out-of-state": ["Out-of-state", "Out-of-state owner"],
    "Absentee (TX)": ["Absentee (TX)"],
    "Local": ["Local", "Texas owner"],
    "Unknown": ["Unknown"],
  };

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

    wireFilterBar();
    wireViolations();
    wireTaxSales();

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

  // ---- Busy indicator (slim bar under the filter bar) -------------------
  let busyCount = 0;
  function busy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    document.getElementById("progress").classList.toggle("hidden", busyCount === 0);
  }
  // Show while the map is pulling tiles; hide when it settles.
  let tilesBusy = false;
  map.on("sourcedataloading", () => { if (!tilesBusy) { tilesBusy = true; busy(true); } });
  map.on("idle", () => { if (tilesBusy) { tilesBusy = false; busy(false); } });

  // Contact lookup links. County data lists people as "LASTNAME FIRST MIDDLE";
  // flip to "First Middle Lastname" for people-search sites. Entities (LLC,
  // trust, etc.) go to a corporate-registry search instead.
  const ENTITY_RE = /\b(LLC|INC|CORP|LP|LLP|LTD|TRUST|TR|CO|COMPANY|PARTNERS|HOLDINGS|PROPERTIES|INVESTMENTS|CHURCH|CITY|COUNTY|BANK|ESTATE|ESTATES)\b/i;

  function contactLinksHTML(p) {
    const rawName = (p.owner_names || p.name || "").split(";")[0].split("&")[0].trim();
    if (!rawName) return "";
    const links = [];
    if (ENTITY_RE.test(rawName)) {
      links.push(`<a href="https://opencorporates.com/companies/us_tx?q=${encodeURIComponent(rawName)}" target="_blank" rel="noopener">🏢 Look up entity</a>`);
    } else {
      const parts = rawName.split(/\s+/);
      const flipped = parts.length > 1 ? parts.slice(1).join(" ") + " " + parts[0] : rawName;
      const loc = (p.owner_location || "").trim() || "TX";
      links.push(`<a href="https://www.truepeoplesearch.com/results?name=${encodeURIComponent(flipped)}&citystatezip=${encodeURIComponent(loc)}" target="_blank" rel="noopener">📞 Find contact</a>`);
    }
    if (!blank(p.mail_addr)) {
      const full = p.mail_addr + (blank(p.owner_location) ? "" : ", " + p.owner_location);
      links.push(`<a href="#" class="copy-addr" data-addr="${esc(full)}">📋 Copy mail addr</a>`);
    }
    // Ownership/value history: DCAD account page + county clerk deed index.
    // (Texas is non-disclosure — deeds show the chain of owners, not prices.)
    if ((p.county || "").toUpperCase() === "DALLAS") {
      if (!blank(p.prop_id)) {
        links.push(`<a href="https://www.dallascad.org/AcctDetail.aspx?ID=${encodeURIComponent(p.prop_id)}" target="_blank" rel="noopener">📜 History (DCAD)</a>`);
      }
      links.push(`<a href="https://dallas.tx.publicsearch.us/results?department=RP&searchType=quickSearch&searchOcrText=false&query=${encodeURIComponent(rawName)}" target="_blank" rel="noopener">📄 Deeds</a>`);
    }
    return `<div class="popup-actions">${links.join(" · ")}</div>`;
  }

  // Delegated handler for the copy button inside popups.
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".copy-addr");
    if (!el) return;
    e.preventDefault();
    navigator.clipboard.writeText(el.dataset.addr).then(() => {
      el.textContent = "✓ Copied";
    });
  });


  // ---- Shared datasets for popup badges (lazy, fetched once) ------------
  let violationsPromise = null, taxSalesPromise = null;
  const getViolationsData = () =>
    (violationsPromise ??= fetch("/api/violations").then((r) => r.json()));
  const getTaxSalesData = () =>
    (taxSalesPromise ??= fetch("/api/taxsales").then((r) => r.json()));

  const normAddr = (a) =>
    String(a || "").toUpperCase().split(",")[0].replace(/\s+/g, " ").trim();

  function distMeters(lngLat, coords) {
    const dx = (coords[0] - lngLat.lng) * 111320 * Math.cos(lngLat.lat * Math.PI / 180);
    const dy = (coords[1] - lngLat.lat) * 110540;
    return Math.hypot(dx, dy);
  }

  // Stamp tax-sale / violation warnings onto an open popup for this property.
  async function annotatePopup(popup, lngLat, addrStr, baseHTML) {
    try {
      busy(true);
      const [v, t] = await Promise.all([getViolationsData(), getTaxSalesData()]);
      const key = normAddr(addrStr);
      const hit = (f) =>
        (key && normAddr(f.properties.address) === key) ||
        distMeters(lngLat, f.geometry.coordinates) < 60;
      const sales = t.features.filter(hit);
      const viols = v.features.filter(hit);
      if (!sales.length && !viols.length) return;
      const b = [];
      if (sales.length) {
        const sp = sales[0].properties;
        b.push(`\u{1F4B0} ${esc(sp.type || "Tax sale")}${sp.min_bid ? " \u2014 min bid " + fmtUSD.format(sp.min_bid) : ""}${sp.sale_date ? " \u00b7 " + esc(sp.sale_date) : ""}`);
      }
      if (viols.length) {
        b.push(`\u26A0\uFE0F ${viols.length} open code case${viols.length > 1 ? "s" : ""} \u2014 ${esc(viols[0].properties.desc)}`);
      }
      if (popup.isOpen()) {
        popup.setHTML(`<div class="popup-badges">${b.join("<br>")}</div>` + baseHTML);
      }
    } catch (err) {
      /* badges are best-effort */
    } finally {
      busy(false);
    }
  }

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
    if (!blank(p.situs_addr)) lines.push(`Property: ${esc(p.situs_addr)}`);
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
    return lines.join("<br>") + contactLinksHTML(p);
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
      // Violations sit on top, then parcels, then counties when zoomed out.
      let html = null;
      let annotateWith = null;
      if (map.getLayer("deals-dots") &&
          map.getLayoutProperty("deals-dots", "visibility") !== "none") {
        const dd = map.queryRenderedFeatures(e.point, { layers: ["deals-dots"] });
        if (dd.length) {
          const p = dd[0].properties;
          html = taxSalePopupHTML(p) + (p.owner ? `<br>Owner: ${esc(p.owner)}` : "");
        }
      }
      if (!html && map.getLayer("search-results")) {
        const s = map.queryRenderedFeatures(e.point, { layers: ["search-results"] });
        if (s.length) { html = searchResultPopupHTML(s[0].properties); annotateWith = s[0].properties.addr; }
      }
      if (!html && map.getLayer("taxsales")) {
        const t = map.queryRenderedFeatures(e.point, { layers: ["taxsales"] });
        if (t.length) html = taxSalePopupHTML(t[0].properties);
      }
      if (!html && map.getLayer("violations")) {
        const v = map.queryRenderedFeatures(e.point, { layers: ["violations"] });
        if (v.length) html = violationPopupHTML(v[0].properties);
      }
      const parcels = html ? [] : map.queryRenderedFeatures(e.point, { layers: ["parcels"] });
      if (parcels.length) {
        html = parcelPopupHTML(parcels[0].properties);
        annotateWith = parcels[0].properties.situs_addr;
      } else {
        const counties = map.queryRenderedFeatures(e.point, { layers: ["counties-fill"] });
        if (counties.length) html = countyPopupHTML(counties[0].properties);
      }
      if (html) {
        const popup = new maplibregl.Popup({ maxWidth: "320px" })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
        if (annotateWith !== null) annotatePopup(popup, e.lngLat, annotateWith, html);
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

  // ---- Filter bar (owner type, value range, owner search, CSV export) --

  const filterState = {
    statuses: new Set(Object.keys(STATUS_ALIASES)),
    min: null,
    max: null,
    query: "",
  };

  function buildFilter() {
    const parts = [];
    if (filterState.statuses.size < Object.keys(STATUS_ALIASES).length) {
      const labels = [...filterState.statuses].flatMap((s) => STATUS_ALIASES[s]);
      parts.push(["in", STATUS_EXPR, ["literal", labels]]);
    }
    const valueExpr = ["to-number", ["coalesce", ["get", "total_value"], 0]];
    if (filterState.min !== null) parts.push([">=", valueExpr, filterState.min]);
    if (filterState.max !== null) parts.push(["<=", valueExpr, filterState.max]);
    if (filterState.query) {
      parts.push([
        ">=",
        ["index-of", filterState.query.toUpperCase(),
          ["upcase", ["coalesce", ["get", "owner_names"], ""]]],
        0,
      ]);
    }
    return parts.length ? ["all", ...parts] : null;
  }

  function applyFilters() {
    map.setFilter("parcels", buildFilter());
    scheduleCount();
  }

  // Parcels straddling tile borders appear once per tile; dedupe for counting/export.
  function visibleParcels() {
    const seen = new Set();
    const out = [];
    for (const f of map.queryRenderedFeatures({ layers: ["parcels"] })) {
      const p = f.properties;
      const key = `${p.owner_names}|${p.mail_addr}|${p.total_value}|${p.accounts}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
    return out;
  }

  let countTimer = null;
  function scheduleCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(updateCount, 250);
  }

  function filtersActive() {
    return filterState.statuses.size < Object.keys(STATUS_ALIASES).length ||
      filterState.min !== null || filterState.max !== null || filterState.query;
  }

  function updateCount() {
    const el = document.getElementById("result-count");
    if (map.getZoom() < cfg.handoffZoom) {
      el.textContent = "zoom in to see parcels";
      return;
    }
    const n = visibleParcels().length;
    if (n === 0 && filtersActive()) {
      el.innerHTML = `no matches — <a href="#" id="clear-filters">clear filters</a>`;
      document.getElementById("clear-filters").addEventListener("click", (e) => {
        e.preventDefault();
        resetFilters();
      });
      return;
    }
    // Below z13 the tiles drop the smallest parcels to stay light — say so.
    const hint = map.getZoom() < 13 ? " · zoom in for all parcels" : "";
    el.textContent = `${fmtInt.format(n)} parcels in view${hint}`;
  }

  function resetFilters() {
    filterState.statuses = new Set(Object.keys(STATUS_ALIASES));
    filterState.min = null;
    filterState.max = null;
    filterState.query = "";
    document.querySelectorAll("#dd-status input[data-status]").forEach((cb) => (cb.checked = true));
    document.getElementById("val-min").value = "";
    document.getElementById("val-max").value = "";
    document.getElementById("owner-search").value = "";
    applyFilters();
  }

  function exportCSV() {
    const rows = visibleParcels();
    if (!rows.length) {
      document.getElementById("result-count").textContent =
        map.getZoom() < cfg.handoffZoom ? "zoom in first, then export" : "nothing to export";
      return;
    }
    const cols = ["owner_names", "owner_status", "situs_addr", "situs_zip",
      "mail_addr", "owner_location", "county", "total_value", "n_owners", "accounts"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.join(",")]
      .concat(rows.map((r) => cols.map((c) => q(r[c])).join(",")))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "dirtfound-parcels.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function wireFilterBar() {
    // Dropdown open/close
    const pairs = [
      ["btn-status", "dd-status"],
      ["btn-value", "dd-value"],
    ];
    for (const [btnId, ddId] of pairs) {
      const btn = document.getElementById(btnId);
      const dd = document.getElementById(ddId);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        for (const [, otherId] of pairs) {
          if (otherId !== ddId) document.getElementById(otherId).classList.add("hidden");
        }
        dd.classList.toggle("hidden");
      });
      dd.addEventListener("click", (e) => e.stopPropagation());
    }
    document.addEventListener("click", () => {
      for (const [, ddId] of pairs) document.getElementById(ddId).classList.add("hidden");
    });

    // Owner type checkboxes
    document.querySelectorAll("#dd-status input[data-status]").forEach((cb) => {
      cb.addEventListener("change", () => {
        cb.checked ? filterState.statuses.add(cb.dataset.status)
                   : filterState.statuses.delete(cb.dataset.status);
        applyFilters();
      });
    });

    // Value range
    const parseVal = (el) => {
      const n = Number(el.value);
      return el.value !== "" && isFinite(n) ? n : null;
    };
    document.getElementById("val-min").addEventListener("input", (e) => {
      filterState.min = parseVal(e.target);
      applyFilters();
    });
    document.getElementById("val-max").addEventListener("input", (e) => {
      filterState.max = parseVal(e.target);
      applyFilters();
    });

    // Owner name box: typing filters the current view; Enter searches everywhere.
    const searchBox = document.getElementById("owner-search");
    let searchTimer = null;
    searchBox.addEventListener("input", (e) => {
      e.target.classList.toggle("active", e.target.value.trim() !== "");
      if (e.target.value.trim() === "") clearSearchResults();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        filterState.query = e.target.value.trim();
        applyFilters();
      }, 300);
    });
    searchBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter") searchEverywhere(searchBox.value.trim());
      if (e.key === "Escape") { searchBox.value = ""; searchBox.classList.remove("active");
        filterState.query = ""; clearSearchResults(); applyFilters(); }
    });

    document.getElementById("export-csv").addEventListener("click", exportCSV);

    map.on("moveend", scheduleCount);
    map.on("idle", scheduleCount);
    scheduleCount();
  }

  // ---- Global owner search (Enter in the owner box → /api/search) -------

  function clearSearchResults() {
    if (map.getLayer("search-results")) map.removeLayer("search-results");
    if (map.getSource("search-results")) map.removeSource("search-results");
  }

  async function searchEverywhere(q) {
    const countEl = document.getElementById("result-count");
    if (q.length < 2) return;
    countEl.textContent = "searching everywhere…";
    busy(true);
    let results;
    try {
      const res = await fetch("/api/search?q=" + encodeURIComponent(q));
      results = (await res.json()).results || [];
    } catch (err) {
      countEl.textContent = "search failed — try again";
      return;
    } finally {
      busy(false);
    }
    clearSearchResults();
    if (!results.length) {
      countEl.textContent = `no owner or address matching “${q}” in the data`;
      return;
    }

    const features = results
      .filter((r) => isFinite(r.lon) && isFinite(r.lat))
      .map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lon, r.lat] },
        properties: r,
      }));
    map.addSource("search-results", {
      type: "geojson",
      data: { type: "FeatureCollection", features },
    });
    map.addLayer({
      id: "search-results",
      type: "circle",
      source: "search-results",
      paint: {
        "circle-radius": 0,
        "circle-radius-transition": { duration: 500 },
        "circle-color": "#16a34a",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
        "circle-opacity": 0.95,
      },
    });

    // Pop the pins in once the layer exists.
    requestAnimationFrame(() => {
      if (map.getLayer("search-results")) {
        map.setPaintProperty("search-results", "circle-radius",
          ["interpolate", ["linear"], ["zoom"], 5, 5, 14, 10]);
      }
    });

    const bounds = features.reduce(
      (b, f) => b.extend(f.geometry.coordinates),
      new maplibregl.LngLatBounds(features[0].geometry.coordinates, features[0].geometry.coordinates)
    );
    map.fitBounds(bounds, { padding: 90, maxZoom: 15 });
    countEl.textContent = `${fmtInt.format(features.length)} matches for “${q}” — green pins`;

    // Single match: open its details right away instead of waiting for a click.
    if (features.length === 1) {
      const f = features[0];
      map.once("moveend", () => {
        const html = searchResultPopupHTML(f.properties);
        const popup = new maplibregl.Popup({ maxWidth: "320px" })
          .setLngLat(f.geometry.coordinates)
          .setHTML(html)
          .addTo(map);
        annotatePopup(popup, { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] },
          f.properties.addr, html);
      });
    }
  }

  function searchResultPopupHTML(p) {
    return [
      `<strong>${esc(p.name)}</strong>`,
      STATUS_LABELS[p.status] || null,
      blank(p.addr) ? null : `Property: ${esc(p.addr)}`,
      `${esc(p.county)} County`,
      p.value ? `Total value: ${fmtUSD.format(p.value)}` : null,
    ].filter(Boolean).join("<br>") + contactLinksHTML(p);
  }

  // ---- Code violations layer (Austin open data via /api/violations) ----

  function wireViolations() {
    const toggle = document.getElementById("violations-toggle");
    const legendRow = document.getElementById("legend-violations");
    let loaded = false;

    const sync = async () => {
      legendRow.classList.toggle("hidden", !toggle.checked);
      if (toggle.checked && !loaded) {
        loaded = true;
        busy(true);
        try {
          const res = await fetch("/api/violations");
          const geojson = await res.json();
          map.addSource("violations", { type: "geojson", data: geojson });
          map.addLayer({
            id: "violations",
            type: "circle",
            source: "violations",
            minzoom: 9,
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 7],
              "circle-color": "#9333ea",
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1.25,
              "circle-opacity": 0.9,
            },
          });
        } catch (err) {
          console.error("violations load failed:", err);
          toggle.checked = false;
          legendRow.classList.add("hidden");
          loaded = false;
        } finally {
          busy(false);
        }
        return;
      }
      if (map.getLayer("violations")) {
        map.setLayoutProperty("violations", "visibility", toggle.checked ? "visible" : "none");
      }
    };
    toggle.addEventListener("change", sync);
    if (toggle.checked) sync(); // box ticked before the map finished loading
  }

  // ---- Tax foreclosure sales layer (statewide TX via /api/taxsales) -----

  function wireTaxSales() {
    const toggle = document.getElementById("taxsales-toggle");
    const legendRow = document.getElementById("legend-taxsales");
    let loaded = false;

    const sync = async () => {
      legendRow.classList.toggle("hidden", !toggle.checked);
      if (toggle.checked && !loaded) {
        loaded = true;
        busy(true);
        try {
          const res = await fetch("/api/taxsales");
          const geojson = await res.json();
          map.addSource("taxsales", { type: "geojson", data: geojson });
          map.addLayer({
            id: "taxsales",
            type: "circle",
            source: "taxsales",
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 5, 14, 8],
              "circle-color": "#eab308",
              "circle-stroke-color": "#78350f",
              "circle-stroke-width": 1.5,
              "circle-opacity": 0.95,
            },
          });
        } catch (err) {
          console.error("tax sales load failed:", err);
          toggle.checked = false;
          legendRow.classList.add("hidden");
          loaded = false;
        } finally {
          busy(false);
        }
        return;
      }
      if (map.getLayer("taxsales")) {
        map.setLayoutProperty("taxsales", "visibility", toggle.checked ? "visible" : "none");
      }
    };
    toggle.addEventListener("change", sync);
    if (toggle.checked) sync();
  }

  function taxSalePopupHTML(p) {
    const lines = [
      `<strong>💰 ${esc(p.type || "Tax sale")}</strong> — ${esc(p.status)}`,
    ];
    if (!blank(p.sale_date)) lines.push(`Sale date: ${esc(p.sale_date)}`);
    if (!blank(p.address)) lines.push(esc(p.address));
    lines.push(esc(p.county));
    if (p.min_bid) lines.push(`Minimum bid: ${fmtUSD.format(p.min_bid)}`);
    if (p.value) lines.push(`Assessed value: ${fmtUSD.format(p.value)}`);
    if (p.min_bid && p.value && p.value > p.min_bid) {
      lines.push(`<strong>Spread: ${fmtUSD.format(p.value - p.min_bid)}</strong>`);
    }
    if (!blank(p.account)) lines.push(`Account: ${esc(p.account)}`);
    if (!blank(p.cause)) lines.push(`Cause #: ${esc(p.cause)}`);
    return lines.join("<br>");
  }

  function violationPopupHTML(p) {
    return [
      `<strong>⚠️ Code case ${esc(p.id)}</strong>`,
      `${esc(p.desc)} — ${esc(p.status)}`,
      blank(p.address) ? null : esc(p.address + (p.zip ? " " + p.zip : "")),
      `Opened ${esc(p.opened)}`,
    ].filter(Boolean).join("<br>");
  }

  // ---- Deal Sheet (the whole tax-sale call list, joined to owners) ------

  let dealsCache = null;
  const dealState = { sort: "spread", dir: -1, county: "", type: "", minSpread: null, ownerOnly: false };

  function tpsLink(ownerName) {
    const raw = String(ownerName || "").split(";")[0].split("&")[0].trim();
    if (!raw || ENTITY_RE.test(raw)) return null;
    const parts = raw.split(/\s+/);
    const flipped = parts.length > 1 ? parts.slice(1).join(" ") + " " + parts[0] : raw;
    return `https://www.truepeoplesearch.com/results?name=${encodeURIComponent(flipped)}&citystatezip=TX`;
  }

  const getToken = () => localStorage.getItem("df_token") || "";

  async function fetchDeals() {
    const res = await fetch("/api/deals", {
      headers: { Authorization: "Bearer " + getToken() },
      cache: "no-store",
    });
    if (res.status === 402) return { paywall: true };
    return { deals: (await res.json()).deals || [] };
  }

  async function tryRenew() {
    const t = getToken();
    if (!t) return false;
    try {
      const res = await fetch("/api/activate?renew=" + encodeURIComponent(t));
      if (!res.ok) return false;
      localStorage.setItem("df_token", (await res.json()).token);
      return true;
    } catch { return false; }
  }

  function paywallHTML() {
    return `<div class="paywall">
      <div class="paywall-icon">💰🔒</div>
      <h3>DirtFound Pro</h3>
      <p>The Deal Sheet joins every Dallas &amp; Travis tax-foreclosure listing to its
      owner on the tax roll — sorted by spread, phone-lookup ready, refreshed every
      12 hours, with CSV export.</p>
      <button class="fbtn primary paywall-btn" id="paywall-buy">Unlock — $100/month</button>
      <p class="paywall-small">Stripe checkout · cancel anytime · already subscribed on
      this browser? Access restores automatically after checkout.</p>
    </div>`;
  }

  async function startCheckout(bodyEl) {
    busy(true);
    try {
      const res = await fetch("/api/checkout");
      const d = await res.json();
      if (d.url) { location.href = d.url; return; }
      bodyEl.textContent = d.error || "Checkout failed.";
    } catch {
      bodyEl.textContent = "Checkout failed — try again.";
    } finally { busy(false); }
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#paywall-buy");
    if (btn) startCheckout(btn.closest(".dealsheet-body") || document.getElementById("dealsheet-body"));
  });

  // Returning from Stripe: ?checkout=cs_... → exchange for an access token.
  (async () => {
    const cs = new URLSearchParams(location.search).get("checkout");
    if (!cs) return;
    history.replaceState(null, "", location.pathname + location.hash);
    busy(true);
    try {
      const res = await fetch("/api/activate?session_id=" + encodeURIComponent(cs));
      if (res.ok) {
        localStorage.setItem("df_token", (await res.json()).token);
        openDealSheet();
      }
    } finally { busy(false); }
  })();

  async function openDealSheet() {
    const panel = document.getElementById("dealsheet");
    const body = document.getElementById("dealsheet-body");
    panel.classList.remove("hidden");
    if (!dealsCache) {
      body.textContent = "Loading…";
      busy(true);
      try {
        let r = await fetchDeals();
        if (r.paywall && (await tryRenew())) r = await fetchDeals();
        if (r.paywall) { body.innerHTML = paywallHTML(); return; }
        dealsCache = r.deals;
      } catch {
        body.textContent = "Failed to load — try again.";
        return;
      } finally { busy(false); }
    }
    renderDeals();
  }


  function updateDealsLayer(rows) {
    const features = rows
      .filter((d) => isFinite(d.lon) && isFinite(d.lat))
      .map((d) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lon, d.lat] },
        properties: d,
      }));
    const data = { type: "FeatureCollection", features };
    if (map.getSource("deals")) {
      map.getSource("deals").setData(data);
    } else {
      map.addSource("deals", { type: "geojson", data });
      map.addLayer({
        id: "deals-dots",
        type: "circle",
        source: "deals",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 4.5, 10, 7, 14, 10],
          "circle-color": "#eab308",
          "circle-stroke-color": "#1f2937",
          "circle-stroke-width": 2,
          "circle-opacity": 0.95,
        },
      });
    }
    map.setLayoutProperty("deals-dots", "visibility", "visible");
    if (features.length) {
      const b = features.reduce(
        (acc, f) => acc.extend(f.geometry.coordinates),
        new maplibregl.LngLatBounds(features[0].geometry.coordinates, features[0].geometry.coordinates));
      // Keep the fitted view clear of the docked panel on the right.
      const panelW = document.getElementById("dealsheet").getBoundingClientRect().width || 0;
      map.fitBounds(b, { padding: { top: 100, bottom: 60, left: 60, right: panelW + 60 }, maxZoom: 13 });
    }
  }

  function dealRows() {
    const spreadOf = (d) => (d.min_bid && d.value) ? d.value - d.min_bid : null;
    let rows = dealsCache.filter((d) =>
      (!dealState.county || d.county === dealState.county) &&
      (!dealState.type || d.type === dealState.type) &&
      (!dealState.ownerOnly || d.owner) &&
      (dealState.minSpread === null || (spreadOf(d) ?? -1) >= dealState.minSpread));
    const key = {
      spread: (d) => spreadOf(d) ?? -1,
      value: (d) => d.value || 0,
      min_bid: (d) => d.min_bid || 0,
      sale_date: (d) => d.sale_date || "",
      address: (d) => d.address || "",
      owner: (d) => d.owner || "\uffff",
    }[dealState.sort];
    rows.sort((a, b) => {
      const ka = key(a), kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * dealState.dir;
    });
    return rows;
  }

  function renderDeals() {
    const body = document.getElementById("dealsheet-body");
    const rows = dealRows();
    updateDealsLayer(rows);
    const arrow = (col) => dealState.sort === col ? (dealState.dir < 0 ? " \u25BC" : " \u25B2") : "";
    const controls = `<div class="deal-controls">
      <select id="dc-county">
        <option value="">All counties</option>
        <option${dealState.county === "DALLAS COUNTY" ? " selected" : ""} value="DALLAS COUNTY">Dallas</option>
        <option${dealState.county === "TRAVIS COUNTY" ? " selected" : ""} value="TRAVIS COUNTY">Travis</option>
      </select>
      <select id="dc-type">
        <option value="">All types</option>
        ${["SALE", "RESALE", "STRUCK OFF", "FUTURE SALE"].map((t) =>
          `<option${dealState.type === t ? " selected" : ""} value="${t}">${t.toLowerCase()}</option>`).join("")}
      </select>
      <label>Min spread $ <input type="number" id="dc-spread" step="25000" min="0"
        value="${dealState.minSpread ?? ""}" placeholder="0"></label>
      <label><input type="checkbox" id="dc-owner"${dealState.ownerOnly ? " checked" : ""}> owner matched</label>
      <span class="deal-count">${fmtInt.format(rows.length)} deals</span>
    </div>`;
    const tr = rows.map((d) => {
      const spread = (d.min_bid && d.value) ? d.value - d.min_bid : null;
      const tps = tpsLink(d.owner);
      const links = [
        tps ? `<a href="${tps}" target="_blank" rel="noopener">\u{1F4DE}</a>` : "",
        d.county === "DALLAS COUNTY" && d.account
          ? `<a href="https://www.dallascad.org/AcctDetail.aspx?ID=${encodeURIComponent(d.account)}" target="_blank" rel="noopener">\u{1F4DC}</a>` : "",
        `<a href="#" class="deal-fly" data-addr="${esc(d.address || "")}" data-lon="${d.lon}" data-lat="${d.lat}">\u{1F5FA}\uFE0F</a>`,
      ].filter(Boolean).join(" ");
      const sub = [(d.type || "").toLowerCase(), d.sale_date || null]
        .filter(Boolean).join(" \u00b7 ");
      return `<tr>
        <td>${esc(d.address || "")}<div class="deal-sub">${esc(sub)} \u00b7 ${esc(d.owner || "?")}</div></td>
        <td class="num">${d.min_bid ? fmtUSD.format(d.min_bid) : "\u2014"}</td>
        <td class="num">${d.value ? fmtUSD.format(d.value) : "\u2014"}</td>
        <td class="num"><strong>${spread !== null && spread > 0 ? fmtUSD.format(spread) : "\u2014"}</strong></td>
        <td class="deal-links">${links}</td>
      </tr>`;
    }).join("");
    body.innerHTML = controls + `<table class="deal-table">
      <thead><tr>
        <th data-sort="address">Property${arrow("address")}</th>
        <th data-sort="min_bid">Min bid${arrow("min_bid")}</th>
        <th data-sort="value">Value${arrow("value")}</th>
        <th data-sort="spread">Spread${arrow("spread")}</th><th></th>
      </tr></thead><tbody>${tr}</tbody></table>`;

    document.getElementById("dc-county").addEventListener("change", (e) => { dealState.county = e.target.value; renderDeals(); });
    document.getElementById("dc-type").addEventListener("change", (e) => { dealState.type = e.target.value; renderDeals(); });
    document.getElementById("dc-spread").addEventListener("change", (e) => {
      dealState.minSpread = e.target.value === "" ? null : Number(e.target.value); renderDeals();
    });
    document.getElementById("dc-owner").addEventListener("change", (e) => { dealState.ownerOnly = e.target.checked; renderDeals(); });
    body.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (!col) return;
      if (dealState.sort === col) dealState.dir *= -1;
      else { dealState.sort = col; dealState.dir = col === "address" || col === "owner" ? 1 : -1; }
      renderDeals();
    }));
  }

  function dealsCSV() {
    if (!dealsCache) return;
    const cols = ["address", "county", "type", "status", "sale_date", "min_bid",
      "value", "owner", "account", "cause"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.concat("spread").join(",")].concat(dealRows().map((d) =>
      cols.map((c) => q(d[c])).concat(q(d.min_bid && d.value ? d.value - d.min_bid : "")).join(","))).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "dirtfound-deal-sheet.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  document.getElementById("deal-sheet-btn").addEventListener("click", openDealSheet);
  document.getElementById("dealsheet-close").addEventListener("click", () => {
    document.getElementById("dealsheet").classList.add("hidden");
    if (map.getLayer("deals-dots")) map.setLayoutProperty("deals-dots", "visibility", "none");
  });
  document.getElementById("deals-csv").addEventListener("click", dealsCSV);

  // ---- Delinquent Tax panel (Dallas County TRW export) -----------------

  let delinquentCache = null;
  let delinquentMeta = null;
  const delinquentState = { sort: "amount_due", dir: -1, q: "" };

  async function fetchDelinquent(q) {
    const res = await fetch("/api/delinquent" + (q ? "?q=" + encodeURIComponent(q) : ""), {
      headers: { Authorization: "Bearer " + getToken() },
      cache: "no-store",
    });
    if (res.status === 402) return { paywall: true };
    return await res.json();
  }

  function delinquentPaywallHTML() {
    return `<div class="paywall">
      <div class="paywall-icon">🧾🔒</div>
      <h3>DirtFound Pro</h3>
      <p>95,000+ Dallas County accounts currently behind on property taxes, straight
      from the county's own tax roll — the earliest, least-competed-for distress
      signal there is. Included with the same Pro subscription as the Deal Sheet.</p>
      <button class="fbtn primary paywall-btn" id="paywall-buy">Unlock — $100/month</button>
      <p class="paywall-small">Stripe checkout · cancel anytime · already subscribed on
      this browser? Access restores automatically after checkout.</p>
    </div>`;
  }

  async function openDelinquent() {
    const panel = document.getElementById("delinquent-panel");
    const body = document.getElementById("delinquent-body");
    panel.classList.remove("hidden");
    if (!delinquentCache) {
      body.textContent = "Loading…";
      busy(true);
      try {
        let r = await fetchDelinquent("");
        if (r.paywall && (await tryRenew())) r = await fetchDelinquent("");
        if (r.paywall) { body.innerHTML = delinquentPaywallHTML(); return; }
        delinquentCache = r.delinquent;
        delinquentMeta = { total: r.total, total_owed: r.total_owed };
      } catch {
        body.textContent = "Failed to load — try again.";
        return;
      } finally { busy(false); }
    }
    renderDelinquent();
  }

  function delinquentRows() {
    const key = {
      amount_due: (d) => d.amount_due || 0,
      years_delinquent: (d) => d.years_delinquent || 0,
      owner: (d) => d.owner || "￿",
      city: (d) => d.city || "￿",
    }[delinquentState.sort];
    const rows = delinquentCache.slice();
    rows.sort((a, b) => {
      const ka = key(a), kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * delinquentState.dir;
    });
    return rows;
  }

  function renderDelinquent() {
    const body = document.getElementById("delinquent-body");
    const rows = delinquentRows();
    const arrow = (col) => delinquentState.sort === col ? (delinquentState.dir < 0 ? " ▼" : " ▲") : "";
    const shownNote = delinquentMeta
      ? `Showing top ${fmtInt.format(rows.length)} of ${fmtInt.format(delinquentMeta.total)} accounts · ${fmtUSD.format(delinquentMeta.total_owed)} owed county-wide`
      : "";
    const controls = `<div class="deal-controls">
      <input type="search" id="dq-search" placeholder="Search owner or address…" value="${esc(delinquentState.q)}" style="flex:1;min-width:160px">
      <span class="deal-count">${shownNote}</span>
    </div>`;
    const tr = rows.map((d) => {
      const tps = tpsLink(d.owner);
      const links = [
        tps ? `<a href="${tps}" target="_blank" rel="noopener">\u{1F4DE}</a>` : "",
        d.account ? `<a href="https://www.dallascad.org/AcctDetail.aspx?ID=${encodeURIComponent(d.account)}" target="_blank" rel="noopener">\u{1F4DC}</a>` : "",
      ].filter(Boolean).join(" ");
      const sub = [
        d.city ? esc(d.city) : "",
        d.years_delinquent ? `${d.years_delinquent} yr${d.years_delinquent === 1 ? "" : "s"} behind` : "",
        d.suit ? `\u{2696}️ suit ${esc(d.causeno || "pending")}` : "",
      ].filter(Boolean).join(" · ");
      return `<tr>
        <td>${esc(d.owner || "?")}<div class="deal-sub">${esc(d.address || "")}${sub ? " · " + sub : ""}</div></td>
        <td class="num"><strong>${fmtUSD.format(d.amount_due || 0)}</strong></td>
        <td class="deal-links">${links}</td>
      </tr>`;
    }).join("");
    body.innerHTML = controls + `<table class="deal-table">
      <thead><tr>
        <th data-sort="owner">Owner${arrow("owner")}</th>
        <th data-sort="amount_due">Amount due${arrow("amount_due")}</th><th></th>
      </tr></thead><tbody>${tr}</tbody></table>`;

    document.getElementById("dq-search").addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      delinquentState.q = e.target.value.trim();
      body.innerHTML = controls + "Searching…";
      busy(true);
      try {
        const r = await fetchDelinquent(delinquentState.q);
        if (!r.paywall) { delinquentCache = r.delinquent; delinquentMeta = { total: r.total, total_owed: r.total_owed }; }
        renderDelinquent();
      } finally { busy(false); }
    });
    body.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (!col) return;
      if (delinquentState.sort === col) delinquentState.dir *= -1;
      else { delinquentState.sort = col; delinquentState.dir = col === "owner" ? 1 : -1; }
      renderDelinquent();
    }));
  }

  function delinquentCSV() {
    if (!delinquentCache) return;
    const cols = ["account", "owner", "address", "city", "state", "zip", "amount_due", "years_delinquent", "oldest_year", "due_date", "suit", "causeno"];
    const q2 = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.join(",")].concat(delinquentRows().map((d) => cols.map((c) => q2(d[c])).join(","))).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "dirtfound-delinquent-tax.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  document.getElementById("delinquent-btn").addEventListener("click", openDelinquent);
  document.getElementById("delinquent-close").addEventListener("click", () => {
    document.getElementById("delinquent-panel").classList.add("hidden");
  });
  document.getElementById("delinquent-csv").addEventListener("click", delinquentCSV);
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".deal-fly");
    if (!el) return;
    e.preventDefault();
    map.flyTo({ center: [Number(el.dataset.lon), Number(el.dataset.lat)], zoom: 16 });
  });

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
