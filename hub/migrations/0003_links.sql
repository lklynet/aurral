CREATE TABLE links (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_code TEXT UNIQUE,
  expires_at INTEGER,
  account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  linked_at INTEGER
);

CREATE INDEX links_account_idx ON links (account_id);
