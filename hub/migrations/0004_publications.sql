CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES links (id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  track_count INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delisted INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX publications_ref_idx ON publications (link_id, ref);
CREATE INDEX publications_published_idx ON publications (published_at);
