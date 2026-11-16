CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  tunnel_url TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  instance_id TEXT NOT NULL,
  token TEXT NOT NULL,
  manifest TEXT NOT NULL,
  share_files INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, token)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_public_code ON shares (substr(token, 1, 15));
