DROP TABLE IF EXISTS owners;
CREATE TABLE owners (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT, addr TEXT, county TEXT, value REAL, lon REAL, lat REAL
);
CREATE VIRTUAL TABLE IF NOT EXISTS owners_fts USING fts5(name, content='owners', content_rowid='id');
