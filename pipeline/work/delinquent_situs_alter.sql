ALTER TABLE delinquent_dallas ADD COLUMN situs_addr TEXT;
ALTER TABLE delinquent_dallas ADD COLUMN situs_city TEXT;
ALTER TABLE delinquent_dallas ADD COLUMN situs_zip TEXT;
ALTER TABLE delinquent_dallas ADD COLUMN lon REAL;
ALTER TABLE delinquent_dallas ADD COLUMN lat REAL;
CREATE INDEX idx_delinquent_situs_city ON delinquent_dallas(situs_city);
