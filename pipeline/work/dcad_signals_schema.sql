CREATE TABLE dcad_signals (
  account TEXT PRIMARY KEY,
  owner_name TEXT,
  owner_city TEXT,
  owner_state TEXT,
  owner_zip TEXT,
  situs_addr TEXT,
  situs_city TEXT,
  situs_zip TEXT,
  yr_built INTEGER,
  living_sf REAL,
  beds TEXT,
  baths TEXT,
  pool INTEGER,
  deed_date TEXT,
  years_owned INTEGER,
  long_tenure INTEGER,
  old_home INTEGER,
  small_home INTEGER,
  teardown_candidate INTEGER,
  absentee INTEGER,
  out_of_state INTEGER,
  over65 INTEGER,
  disabled INTEGER,
  deferred INTEGER,
  homestead INTEGER,
  lon REAL,
  lat REAL
);
CREATE INDEX idx_dcad_teardown ON dcad_signals(teardown_candidate);
CREATE INDEX idx_dcad_over65 ON dcad_signals(over65);
CREATE INDEX idx_dcad_disabled ON dcad_signals(disabled);
CREATE INDEX idx_dcad_absentee ON dcad_signals(absentee);
CREATE INDEX idx_dcad_deferred ON dcad_signals(deferred);
