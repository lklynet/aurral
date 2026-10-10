export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const TUNNEL_URL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

const schemaReady = new WeakMap();

function ensureSchema(db) {
  if (!schemaReady.has(db)) {
    const ready = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS instances (
          id TEXT PRIMARY KEY,
          secret_hash TEXT NOT NULL,
          tunnel_url TEXT,
          updated_at INTEGER NOT NULL
        )`,
      )
      .run()
      .catch((error) => {
        schemaReady.delete(db);
        throw error;
      });
    schemaReady.set(db, ready);
  }
  return schemaReady.get(db);
}

export async function getInstance(db, id) {
  if (!db || !INSTANCE_ID_PATTERN.test(id)) return null;
  await ensureSchema(db);
  return db.prepare("SELECT id, secret_hash, tunnel_url FROM instances WHERE id = ?").bind(id).first();
}

export async function saveInstance(db, { id, secretHash, tunnelUrl }) {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO instances (id, secret_hash, tunnel_url, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tunnel_url = excluded.tunnel_url, updated_at = excluded.updated_at`,
    )
    .bind(id, secretHash, tunnelUrl, Date.now())
    .run();
}
