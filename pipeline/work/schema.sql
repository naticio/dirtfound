DROP TABLE IF EXISTS owners_fts;
DROP TABLE IF EXISTS owners;
CREATE TABLE owners (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT, addr TEXT, county TEXT, value REAL, lon REAL, lat REAL
);
CREATE VIRTUAL TABLE owners_fts USING fts5(name, addr, content='owners', content_rowid='id');
