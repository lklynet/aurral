CREATE TABLE connect_entitlements (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  max_servers INTEGER NOT NULL DEFAULT 3,
  current_period_end INTEGER,
  trial_used_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE connect_servers (
  instance_id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lan_hints TEXT NOT NULL DEFAULT '[]',
  online INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX connect_servers_owner_idx ON connect_servers (owner_account_id);

CREATE TABLE connect_slugs (
  slug TEXT PRIMARY KEY,
  instance_id TEXT UNIQUE REFERENCES connect_servers (instance_id) ON DELETE SET NULL,
  released_at INTEGER
);

CREATE TABLE connect_auth_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE connect_client_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX connect_client_tokens_account_idx ON connect_client_tokens (account_id);
