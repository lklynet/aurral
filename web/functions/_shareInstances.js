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
  return db
    .prepare("SELECT id, secret_hash, tunnel_url FROM instances WHERE id = ?")
    .bind(id)
    .first();
}

export async function saveInstance(db, { id, secretHash, tunnelUrl }) {
  await ensureSchema(db);
  const result = await db
    .prepare(
      `INSERT INTO instances (id, secret_hash, tunnel_url, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tunnel_url = excluded.tunnel_url, updated_at = excluded.updated_at
       WHERE instances.secret_hash = excluded.secret_hash`,
    )
    .bind(id, secretHash, tunnelUrl, Date.now())
    .run();
  return result.meta.changes > 0;
}

export async function authorizeShareInstance(db, id, secret) {
  if (!db || !INSTANCE_ID_PATTERN.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const secretHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const instance = await getInstance(db, id);
  if (!instance) return saveInstance(db, { id, secretHash, tunnelUrl: null });
  let difference = instance.secret_hash.length ^ secretHash.length;
  for (let index = 0; index < secretHash.length; index += 1) {
    difference |= instance.secret_hash.charCodeAt(index) ^ secretHash.charCodeAt(index);
  }
  return difference === 0;
}
