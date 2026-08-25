CREATE TABLE delinquent_dallas (
  account TEXT PRIMARY KEY,
  owner TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  parcel_name TEXT,
  amount_due REAL,
  years_delinquent INTEGER,
  oldest_year INTEGER,
  due_date TEXT,
  suit INTEGER,
  causeno TEXT
);
CREATE INDEX idx_delinquent_amount ON delinquent_dallas(amount_due DESC);
CREATE VIRTUAL TABLE delinquent_fts USING fts5(owner, address, content='delinquent_dallas', content_rowid='rowid');
