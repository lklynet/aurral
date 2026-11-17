CREATE TABLE friends (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, friend_id)
);

CREATE INDEX friends_friend_idx ON friends (friend_id);
