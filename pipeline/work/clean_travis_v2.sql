-- Travis County parcels v2: adds owner_status absentee classification.
--   Out-of-state    — owner's mailing address is outside Texas (hottest lead)
--   Absentee (TX)   — Texas owner, but mailing ZIP differs from property ZIP
--   Local           — mailing ZIP matches property ZIP
--   Unknown         — property ZIP missing (45% of Travis) or no owner state
-- Travis quirks: SITUS street/city and land-use codes are blank; IMP_VALUE is
-- all zeros, so a vacant-land flag is not derivable from this dataset.
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
  substr(trim(SITUS_ZIP), 1, 5) AS situs_zip5,
  substr(trim(MAIL_ZIP), 1, 5) AS mail_zip5,
  CASE
    -- is_tx: mail state says Texas (or Tarrant-style "CITY, TX" in the city field)
    -- unknown_loc: no state info at all
    WHEN NOT (upper(trim(MAIL_STAT)) IN ('TX', 'TEXAS')
              OR regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) = 'TX')
      AND NOT (upper(trim(MAIL_STAT)) = ''
               AND regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) = '')
      THEN 'Out-of-state'
    WHEN (upper(trim(MAIL_STAT)) IN ('TX', 'TEXAS')
          OR regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) = 'TX')
      AND length(trim(SITUS_ZIP)) >= 5 AND length(trim(MAIL_ZIP)) >= 5
      AND substr(trim(SITUS_ZIP), 1, 5) != substr(trim(MAIL_ZIP), 1, 5)
      THEN 'Absentee (TX)'
    WHEN (upper(trim(MAIL_STAT)) IN ('TX', 'TEXAS')
          OR regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) = 'TX')
      AND length(trim(SITUS_ZIP)) >= 5 AND length(trim(MAIL_ZIP)) >= 5
      THEN 'Local'
    ELSE 'Unknown'
  END AS owner_status,
  CASE
    WHEN regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) != ''
      THEN nullif(trim(MAIL_CITY), '')
    WHEN nullif(trim(MAIL_CITY), '') IS NOT NULL AND upper(trim(MAIL_STAT)) != ''
      THEN trim(MAIL_CITY) || ', ' || upper(trim(MAIL_STAT))
    WHEN upper(trim(MAIL_STAT)) != ''
      THEN upper(trim(MAIL_STAT))
  END AS owner_location,
  nullif(trim(MAIL_ADDR), '') AS mail_addr,
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
    mode(owner_status) AS owner_status,
    arg_min(owner_location, owner) AS owner_location,
    arg_min(mail_addr, owner) AS mail_addr,
    max(value) AS value,
    min(situs_zip5) AS situs_zip,
    min(COUNTY) AS county
  FROM prepped
  GROUP BY Shape, Prop_ID
)
SELECT
  Shape,
  count(*) AS accounts,
  list_sort(list_distinct(flatten(array_agg(owners_list)))) AS owners_all,
  mode(owner_status) AS owner_status,
  arg_min(owner_location, owner_rep) AS owner_location,
  arg_min(mail_addr, owner_rep) AS mail_addr,
  min(situs_zip) AS situs_zip,
  min(county) AS county,
  sum(value) AS total_value
FROM accounts
GROUP BY Shape;

SELECT owner_status, count(*) n FROM cleaned GROUP BY 1 ORDER BY n DESC;

COPY (
  SELECT
    Shape,
    accounts,
    owner_status,
    owner_location,
    mail_addr,
    situs_zip,
    county,
    total_value,
    len(owners_all) AS n_owners,
    array_to_string(list_slice(owners_all, 1, 3), '; ') AS owner_names,
    (accounts > 1)::INT AS stacked
  FROM cleaned
) TO 'travis_parcels_v2.geojsonl' (FORMAT gdal, DRIVER 'GeoJSONSeq');
