-- Saat aralıklı takiplerde her uçuşu ayrı izlemek için
CREATE TABLE IF NOT EXISTS track_flights (
  track_id   INTEGER NOT NULL,
  date       TEXT NOT NULL,
  flight_key TEXT NOT NULL,
  flight     TEXT,
  time       TEXT,
  route      TEXT,
  price      REAL,
  direct     INTEGER,
  PRIMARY KEY (track_id, date, flight_key)
);
