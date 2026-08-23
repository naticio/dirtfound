-- Clean TxGIO statewide parcels and collapse stacked geometries.
-- Run:  duckdb tx_parcels.duckdb < clean_parcels.sql
-- DuckDB translation of the R/duckspatial workflow in
-- https://walker-data.com/posts/millions-of-parcels

INSTALL spatial; LOAD spatial;

CREATE OR REPLACE TABLE parcels AS
SELECT * FROM ST_Read('stratmap25-landparcels_48.gdb');

CREATE OR REPLACE TABLE parcels_prepped AS
SELECT
  SHAPE,
  Prop_ID,
  nullif(trim(OWNER_NAME), '') AS owner,
  nullif(try_cast(regexp_replace(MKT_VALUE, '[$, ]', '', 'g') AS DOUBLE), 0) AS value,
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
FROM parcels
WHERE SHAPE IS NOT NULL;

-- First pass: collapse ownership records into tax accounts (SHAPE + Prop_ID),
-- second pass: collapse tax accounts into unique geometries.
CREATE OR REPLACE TABLE parcels_clean AS
WITH accounts AS (
  SELECT
    SHAPE,
    Prop_ID,
    list_distinct(array_agg(owner)) AS owners_list,
    min(owner) AS owner_rep,
    mode(owner_origin) AS owner_origin,
    arg_min(owner_location, owner) AS owner_location,
    max(value) AS value,
    min(situs) AS situs_addr,
    min(COUNTY) AS county
  FROM parcels_prepped
  GROUP BY SHAPE, Prop_ID
)
SELECT
  SHAPE,
  count(*) AS accounts,
  list_sort(list_distinct(flatten(array_agg(owners_list)))) AS owners_all,
  mode(owner_origin) AS owner_origin,
  arg_min(owner_location, owner_rep) AS owner_location,
  min(situs_addr) AS situs_addr,
  min(county) AS county,
  sum(value) AS total_value,
  len(list_sort(list_distinct(flatten(array_agg(owners_list))))) AS n_owners,
  array_to_string(list_slice(list_sort(list_distinct(flatten(array_agg(owners_list)))), 1, 3), '; ') AS owner_names,
  (count(*) > 1)::INT AS stacked
FROM accounts
GROUP BY SHAPE;

-- Write the tiling input (WGS84, list column dropped).
COPY (
  SELECT
    ST_Transform(SHAPE, 'EPSG:3857', 'EPSG:4326') AS geometry,
    accounts, owner_origin, owner_location, situs_addr,
    county, total_value, n_owners, owner_names, stacked
  FROM parcels_clean
) TO 'tx_parcels_tiles.parquet' (FORMAT parquet);
