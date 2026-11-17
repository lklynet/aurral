CREATE TABLE listening (
  link_id TEXT PRIMARY KEY REFERENCES links (id) ON DELETE CASCADE,
  now_playing TEXT,
  playing_until INTEGER,
  top_plays TEXT,
  top_plays_at INTEGER
);
