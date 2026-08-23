-- County-level ownership stats for the zoomed-out choropleth.
-- Run:  duckdb tx_parcels.duckdb < county_stats.sql

COPY (
  WITH classified AS (
    SELECT
      COUNTY,
      nullif(trim(OWNER_NAME), '') AS owner,
      CASE
        WHEN upper(trim(MAIL_STAT)) IN ('TX', 'TEXAS')
          OR regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) = 'TX'
          THEN 'Texas owner'
        WHEN upper(trim(MAIL_STAT)) = ''
          AND regexp_extract(upper(MAIL_CITY), ',\s*([A-Z]{2})\s*$', 1) = ''
          THEN 'Unknown'
        ELSE 'Out-of-state owner'
      END AS owner_origin
    FROM parcels
  )
  SELECT
    COUNTY,
    count(*) AS parcel_records,
    count(DISTINCT owner) AS unique_owners,
    sum((owner_origin = 'Out-of-state owner')::INT) AS out_of_state,
    round(100.0 * sum((owner_origin = 'Out-of-state owner')::INT) / count(*), 1)
      AS pct_out_of_state
  FROM classified
  GROUP BY COUNTY
  ORDER BY pct_out_of_state DESC
) TO 'county_stats.csv' (HEADER);
