CREATE TABLE IF NOT EXISTS users (
  chat_id    INTEGER PRIMARY KEY,
  name       TEXT,
  allowed    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  origin      TEXT NOT NULL,  -- görünen ad, örn. "İstanbul"
  dest        TEXT NOT NULL,
  dep_ports   TEXT NOT NULL,  -- virgülle: "SAW,IST"
  arr_ports   TEXT NOT NULL,
  date_from   TEXT NOT NULL,  -- YYYY-MM-DD
  date_to     TEXT NOT NULL,
  target      REAL,           -- NULL: her değişiklikte bildir
  initialized INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tracks_chat ON tracks(chat_id);

-- Her takip için gün gün son görülen en ucuz fiyat
CREATE TABLE IF NOT EXISTS track_prices (
  track_id INTEGER NOT NULL,
  date     TEXT NOT NULL,
  price    REAL,              -- NULL: o gün satışta uçuş yok
  time     TEXT,
  flight   TEXT,
  route    TEXT,              -- "SAW-ADB"
  PRIMARY KEY (track_id, date)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
