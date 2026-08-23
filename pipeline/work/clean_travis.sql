-- Travis County run of the parcel-cleaning pipeline (schema matches statewide;
-- values are already numeric and geometry is already EPSG:4326 in county files).
INSTALL spatial; LOAD spatial;

CREATE OR REPLACE TABLE prepped AS
SELECT
  Shape,
  Prop_ID,
  nullif(trim(OWNER_NAME), '') AS owner,
  nullif(MKT_VALUE, 0) AS value,
  upper(trim(MAIL_STAT)) AS st,
  regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) AS city_st,
  nullif(trim(MAIL_CITY), '') AS mail_city,
  CASE
    WHEN upper(trim(MAIL_STAT)) IN ('TX', 'TEXAS')
      OR regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) = 'TX'
      THEN 'Texas owner'
    WHEN upper(trim(MAIL_STAT)) = ''
      AND regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) = ''
      THEN 'Unknown'
    ELSE 'Out-of-state owner'
  END AS owner_origin,
  CASE
    WHEN regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) != ''
      THEN nullif(trim(MAIL_CITY), '')
    WHEN nullif(trim(MAIL_CITY), '') IS NOT NULL AND upper(trim(MAIL_STAT)) != ''
      THEN trim(MAIL_CITY) || ', ' || upper(trim(MAIL_STAT))
    WHEN upper(trim(MAIL_STAT)) != ''
      THEN upper(trim(MAIL_STAT))
  END AS owner_location,
  CASE WHEN regexp_matches(SITUS_ADDR, '[A-Za-z0-9]') THEN trim(SITUS_ADDR) END AS situs,
  COUNTY
FROM ST_Read('fgdb/stratmap25-landparcels_48453_travis_202508.gdb')
WHERE Shape IS NOT NULL;

CREATE OR REPLACE TABLE cleaned AS
WITH accounts AS (
  SELECT
    Shape,
    Prop_ID,
    list_distinct(array_agg(owner)) AS owners_list,
    min(owner) AS owner_rep,
    mode(owner_origin) AS owner_origin,
    arg_min(owner_location, owner) AS owner_location,
    max(value) AS value,
    min(situs) AS situs_addr,
    min(COUNTY) AS county
  FROM prepped
  GROUP BY Shape, Prop_ID
)
SELECT
  Shape,
  count(*) AS accounts,
  list_sort(list_distinct(flatten(array_agg(owners_list)))) AS owners_all,
  mode(owner_origin) AS owner_origin,
  arg_min(owner_location, owner_rep) AS owner_location,
  min(situs_addr) AS situs_addr,
  min(county) AS county,
  sum(value) AS total_value
FROM accounts
GROUP BY Shape;

SELECT count(*) AS unique_parcels,
       sum((accounts > 1)::INT) AS formerly_stacked,
       sum((owner_origin = 'Out-of-state owner')::INT) AS out_of_state
FROM cleaned;

COPY (
  SELECT
    Shape,
    accounts,
    owner_origin,
    owner_location,
    situs_addr,
    county,
    total_value,
    len(owners_all) AS n_owners,
    array_to_string(list_slice(owners_all, 1, 3), '; ') AS owner_names,
    (accounts > 1)::INT AS stacked
  FROM cleaned
) TO 'travis_parcels.geojsonl' (FORMAT gdal, DRIVER 'GeoJSONSeq');
