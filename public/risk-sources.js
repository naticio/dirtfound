// DirtFound due-diligence data sources — Dallas + the Park Cities.
//
// Public ArcGIS services (FEMA, City of Dallas, University Park, HIFLD, NPS,
// TxWRAP), queried straight from the browser: every one of them sends CORS
// headers. Exposes window.DIRT_RISK = { layer(id, bbox, signal), checks(lng, lat) }.
(function () {
  "use strict";
  const DALLAS_AGOL = "https://services2.arcgis.com/rwnOSbfKSwyTBcwN/arcgis/rest/services";
  const RISK_URLS = {
    floodZones: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
    floodBfe: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/16",
    easements: `${DALLAS_AGOL}/Plats/FeatureServer/1`,
    dwuConstruction: `${DALLAS_AGOL}/DWU_Pipeline_Committed_Projects_ViewLayer/FeatureServer/0`,
    dwuDesign: `${DALLAS_AGOL}/DWU_Pipeline_Committed_Projects_ViewLayer/FeatureServer/2`,
    transmission: "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer/0",
    dallasZoning: "https://gis.dallascityhall.com/arcgis/rest/services/sdc_public/Zoning/MapServer/15",
    upZoning: "https://gis.uptexas.org/arcgis/rest/services/LandUsePlanning/ZoningDistricts/MapServer/0",
    dallasHistoric: "https://gis.dallascityhall.com/arcgis/rest/services/sdc_public/Zoning/MapServer/2",
    conservation: `${DALLAS_AGOL}/Conservation_Districts_Public_Map/FeatureServer/0`,
    nrhpPolys: "https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer/1",
    nrhpPoints: "https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer/0",
    wui: "https://gis.texaswildfirerisk.com/server/rest/services/TxWRAP/functional_wui_img/ImageServer",
  };

  // Dallas plat easement LINETYPEID → name (from the layer's subtypes).
  const EASEMENT_TYPES = {
    0: "Other", 1: "Alley", 2: "Drainage", 3: "Water", 4: "Wastewater", 5: "Electric",
    6: "Utility", 7: "Gas", 8: "Shared access", 9: "Public safety", 10: "Aerial",
    11: "Telephone", 12: "Floodway management", 13: "Sidewalk", 14: "Wall maintenance",
    16: "Stormwater", 17: "Detention area", 18: "Anchor", 19: "Fence maintenance",
  };

  const isSfha = (a) => a.SFHA_TF === "T";
  const isShadedX = (a) => /0\.2 PCT/i.test(a.ZONE_SUBTY || "");

  // Rough use category for a zoning code, shared by Dallas and University Park.
  function zoneCategory(code) {
    const c = String(code || "").toUpperCase().trim();
    if (/^PD/.test(c)) return "pd";
    if (/^(MF|MH|D\(|D-|D$|TH|CH|2F|4F)/.test(c)) return "res-multi";
    if (/^(R-|R\(|SF|A\(|A-|CD)/.test(c)) return "res-single";
    if (/^(CA|CBD|MU|WMU|WR|UC|CC)/.test(c)) return "mixed";
    if (/^(GO|MO|LO|NO|O-|O\()/.test(c)) return "office";
    if (/^(IR|IM|LI|I-|IND)/.test(c)) return "industrial";
    if (/^(CR|RR|CS|NS|GR|MC|C-|C$|RC|SC|NC|R$)/.test(c)) return "commercial";
    if (/^(OS|PARK)/.test(c)) return "park";
    if (/^(P\(|P$|P-|SP)/.test(c)) return "public";
    return "other";
  }

  // Each vector layer: one or more ArcGIS queries, merged, with a function
  // that maps raw attributes to the small property set the map styles on
  // (return null to drop a feature).
  const RISK_LAYER_SOURCES = {
    flood: [
      { url: RISK_URLS.floodZones, fields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF",
        props: (a) => (isSfha(a) || isShadedX(a))
          ? { kind: "zone", zone: a.FLD_ZONE, sub: a.ZONE_SUBTY, sfha: isSfha(a) } : null },
      { url: RISK_URLS.floodBfe, fields: "ELEV",
        props: (a) => ({ kind: "bfe", elev: Math.round(a.ELEV) }) },
    ],
    sewer: [
      { url: RISK_URLS.easements, where: "LINETYPEID=4", fields: "LINETYPEID",
        props: () => ({ kind: "easement" }) },
      { url: RISK_URLS.dwuConstruction, where: "PIPELENGTHWW>0", fields: "PROJECTLOCATION,STATUS",
        props: (a) => ({ kind: "project", name: a.PROJECTLOCATION, status: a.STATUS }) },
      { url: RISK_URLS.dwuDesign, where: "PIPELENGTHWW>0", fields: "PROJECTLOCATION,STATUS",
        props: (a) => ({ kind: "project", name: a.PROJECTLOCATION, status: a.STATUS }) },
    ],
    powerlines: [
      { url: RISK_URLS.transmission, fields: "VOLTAGE,OWNER,TYPE",
        props: (a) => ({ kv: a.VOLTAGE > 0 ? a.VOLTAGE : null, owner: a.OWNER,
          label: a.VOLTAGE > 0 ? `${a.VOLTAGE} kV` : "Transmission" }) },
    ],
    zoning: [
      { url: RISK_URLS.dallasZoning, fields: "ZONE_DIST,LONG_ZONE_DIST",
        props: (a) => ({ code: a.LONG_ZONE_DIST || a.ZONE_DIST, cat: zoneCategory(a.ZONE_DIST) }) },
      { url: RISK_URLS.upZoning, fields: "ZONECLASS,ZONEDESC",
        props: (a) => ({ code: a.ZONECLASS, desc: a.ZONEDESC, cat: zoneCategory(a.ZONECLASS) }) },
    ],
    easements: [
      { url: RISK_URLS.easements, where: "LINETYPEID<>15", fields: "LINETYPEID",
        props: (a) => ({ type: EASEMENT_TYPES[a.LINETYPEID] || "Easement" }) },
    ],
    heritage: [
      { url: RISK_URLS.dallasHistoric, fields: "H_OVERLAY,NAME",
        props: (a) => ({ kind: "landmark", name: a.NAME || a.H_OVERLAY }) },
      { url: RISK_URLS.conservation, fields: "LONG_ZONE_,COMMON_NAM",
        props: (a) => ({ kind: "district", name: `${a.COMMON_NAM} (${a.LONG_ZONE_})` }) },
      { url: RISK_URLS.nrhpPolys, where: "State='TEXAS'", fields: "RESNAME,ResType",
        props: (a) => ({ kind: /district/i.test(a.ResType || "") ? "district" : "landmark", name: a.RESNAME }) },
      { url: RISK_URLS.nrhpPoints, where: "State='TEXAS'", fields: "RESNAME,ResType",
        props: (a) => ({ kind: "landmark", name: a.RESNAME }) },
    ],
  };

  async function arcQuery(src, params, timeoutMs = 12000, signal) {
    const q = new URLSearchParams({
      where: src.where || "1=1",
      outFields: src.fields,
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      f: "geojson",
      ...params,
    });
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${src.url}/query?${q}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`${src.url}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`${src.url}: ${body.error.message}`);
    return body.features || [];
  }

  // GeoJSON for one layer within bbox [w, s, e, n], merged across its sources.
  async function layer(id, bbox, signal) {
    const sources = RISK_LAYER_SOURCES[id];
    const [w, , e] = bbox;
    // Generalize to roughly a screen pixel at this extent so wide views stay light.
    const tol = ((e - w) / 2000).toFixed(7);
    const results = await Promise.allSettled(sources.map((src) =>
      arcQuery(src, {
        geometry: bbox.join(","),
        geometryType: "esriGeometryEnvelope",
        maxAllowableOffset: tol,
        geometryPrecision: "6",
      }, 15000, signal).then((feats) => feats.flatMap((f) => {
        const props = src.props(f.properties || {});
        return props && f.geometry ? [{ type: "Feature", geometry: f.geometry, properties: props }] : [];
      }))
    ));
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    results.filter((r) => r.status === "rejected").forEach((r) => console.error("layer", id, r.reason));
    return {
      type: "FeatureCollection",
      features: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
      partial: results.some((r) => r.status === "rejected"),
    };
  }
  // Meters from a point to the nearest vertex-segment of any (multi)line/polygon.
  function distanceToGeometryM(lng, lat, geom) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    const rings = geom.type === "LineString" ? [geom.coordinates]
      : geom.type === "MultiLineString" || geom.type === "Polygon" ? geom.coordinates
      : geom.type === "MultiPolygon" ? geom.coordinates.flat()
      : geom.type === "Point" ? [[geom.coordinates]] : [];
    let best = Infinity;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const ax = (ring[i][0] - lng) * kx, ay = (ring[i][1] - lat) * ky;
        if (i === ring.length - 1) { best = Math.min(best, Math.hypot(ax, ay)); break; }
        const bx = (ring[i + 1][0] - lng) * kx, by = (ring[i + 1][1] - lat) * ky;
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
    return best;
  }

  const WUI_CLASSES = {
    1: ["hit", "Primary exposure — homes directly next to burnable wildland"],
    // Nearly all of urban Dallas sits in ember reach, so that's informational.
    2: ["info", "Secondary exposure — within ember reach of wildland fuel (typical for Dallas)"],
    4: ["hit", "Mapped wildfire transmission zone — burnable land on or next to this spot"],
    8: ["hit", "Ember-source area — nearby structures can carry fire"],
    3: ["clear", "Low to no wildfire exposure"],
    7: ["clear", "Water — no wildfire exposure"],
  };

  // The 8-point due-diligence list for one spot (noise is read from map
  // tiles in app.js, since the DOT noise service has no query endpoint).
  async function checks(lng, lat) {
    const pt = { geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint" };
    const near = (m) => ({ ...pt, distance: String(m), units: "esriSRUnit_Meter" });
    const noGeom = { returnGeometry: "false" };
    const q = (key, params, extra = {}) =>
      arcQuery({ url: RISK_URLS[key], fields: extra.fields || "*", where: extra.where }, params, 9000);

    const [wui, flood, sewer, power, dZone, upZone, ease, hist, cons, nrPoly, nrPt] = await Promise.allSettled([
      fetch(`${RISK_URLS.wui}/identify?` + new URLSearchParams({
        geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
        geometryType: "esriGeometryPoint", returnGeometry: "false", returnCatalogItems: "false", f: "json",
      }), { signal: AbortSignal.timeout(9000) }).then((r) => r.json()),
      q("floodZones", { ...pt, ...noGeom }, { fields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF" }),
      q("easements", near(25), { fields: "LINETYPEID", where: "LINETYPEID=4" }),
      q("transmission", near(300), { fields: "VOLTAGE,OWNER" }),
      q("dallasZoning", { ...pt, ...noGeom }, { fields: "ZONE_DIST,LONG_ZONE_DIST" }),
      q("upZoning", { ...pt, ...noGeom }, { fields: "ZONECLASS,ZONEDESC" }),
      q("easements", near(20), { fields: "LINETYPEID", where: "LINETYPEID<>15" }),
      q("dallasHistoric", { ...pt, ...noGeom }, { fields: "H_OVERLAY,NAME" }),
      q("conservation", { ...pt, ...noGeom }, { fields: "LONG_ZONE_,COMMON_NAM" }),
      q("nrhpPolys", { ...pt, ...noGeom }, { fields: "RESNAME,ResType" }),
      q("nrhpPoints", { ...near(40), ...noGeom }, { fields: "RESNAME" }),
    ]);
    const ok = (r) => (r.status === "fulfilled" ? r.value : null);
    const attrs = (r) => (ok(r) || []).map((f) => f.properties || {});
    const inDallas = attrs(dZone).length > 0;
    const inUP = attrs(upZone).length > 0;
    const checks = [];

    // 1. Wildfire (TxWRAP Functional WUI)
    const wv = ok(wui)?.value;
    const wc = WUI_CLASSES[wv];
    checks.push(wc ? { id: "wildfire", status: wc[0], detail: wc[1] }
      : { id: "wildfire", status: "na", detail: "No wildfire data here" });

    // 3. Flood
    if (!ok(flood)) checks.push({ id: "flood", status: "na", detail: "FEMA flood map didn't respond" });
    else {
      const z = attrs(flood)[0];
      if (!z) checks.push({ id: "flood", status: "na", detail: "Not mapped by FEMA here" });
      else if (isSfha(z)) checks.push({ id: "flood", status: "hit",
        detail: `Zone ${z.FLD_ZONE}${/FLOODWAY/i.test(z.ZONE_SUBTY || "") ? " floodway" : ""} — 100-yr floodplain, flood insurance required with a mortgage` });
      else if (isShadedX(z)) checks.push({ id: "flood", status: "hit", detail: "Shaded Zone X — 500-yr (0.2%) floodplain" });
      else checks.push({ id: "flood", status: "clear", detail: `Zone ${z.FLD_ZONE} — minimal flood hazard` });
    }

    // 4. Sewer (Dallas wastewater easements — no public DWU main layer exists)
    if (!inDallas) checks.push({ id: "sewer", status: "na", detail: "Sewer mains not public outside City of Dallas" });
    else if (attrs(sewer).length) checks.push({ id: "sewer", status: "hit", detail: "Wastewater easement within 25 m — can't build over the main" });
    else checks.push({ id: "sewer", status: "clear", detail: "No platted wastewater easement within 25 m" });

    // 5. Powerlines — nearest transmission line within 300 m
    const lines = ok(power);
    if (!lines) checks.push({ id: "powerlines", status: "na", detail: "Transmission-line service didn't respond" });
    else if (!lines.length) checks.push({ id: "powerlines", status: "clear", detail: "No transmission line within 300 m" });
    else {
      const nearest = lines
        .map((f) => ({ p: f.properties, d: distanceToGeometryM(lng, lat, f.geometry) }))
        .sort((a, b) => a.d - b.d)[0];
      const kv = nearest.p.VOLTAGE > 0 ? `${nearest.p.VOLTAGE} kV ` : "";
      checks.push({ id: "powerlines", status: "hit",
        detail: `${kv}transmission line ${Math.round(nearest.d)} m away${nearest.p.OWNER && nearest.p.OWNER !== "NOT AVAILABLE" ? ` (${nearest.p.OWNER})` : ""}` });
    }

    // 6. Zoning
    const dz = attrs(dZone)[0], uz = attrs(upZone)[0];
    if (dz) checks.push({ id: "zoning", status: "info", detail: `${dz.LONG_ZONE_DIST || dz.ZONE_DIST} (City of Dallas)` });
    else if (uz) checks.push({ id: "zoning", status: "info", detail: `${uz.ZONECLASS}${uz.ZONEDESC ? " — " + uz.ZONEDESC : ""} (University Park)` });
    else checks.push({ id: "zoning", status: "na", detail: "No public zoning GIS here (Highland Park: see hptx.org zoning map)" });

    // 7. Easements (Dallas digitized plats)
    const eas = [...new Set(attrs(ease).map((a) => EASEMENT_TYPES[a.LINETYPEID] || "Other"))];
    if (!inDallas) checks.push({ id: "easements", status: "na", detail: "Plat easements only digitized for City of Dallas" });
    else if (eas.length) checks.push({ id: "easements", status: "hit", detail: `${eas.join(", ")} easement${eas.length > 1 ? "s" : ""} on or next to this lot` });
    else checks.push({ id: "easements", status: "clear", detail: "No platted easement within 20 m (check the plat)" });

    // 8. Heritage
    const heritage = [
      ...attrs(hist).map((a) => a.H_OVERLAY === "H/000"
        ? "Pending Dallas landmark designation (demolition moratorium)"
        : `Dallas landmark ${a.H_OVERLAY}${a.NAME ? " " + a.NAME : ""}`),
      ...attrs(cons).map((a) => `Conservation district ${a.LONG_ZONE_} ${a.COMMON_NAM}`),
      ...attrs(nrPoly).map((a) => `National Register: ${a.RESNAME}`),
      ...attrs(nrPt).map((a) => `National Register: ${a.RESNAME}`),
    ];
    const uniq = [...new Set(heritage)];
    checks.push(uniq.length
      ? { id: "heritage", status: "hit", detail: uniq.slice(0, 2).join("; ") }
      : { id: "heritage", status: "clear", detail: "Not in a mapped historic / conservation district" });

    return { checks, inDallas, inUP };
  }

  window.DIRT_RISK = { layer, checks };
})();
