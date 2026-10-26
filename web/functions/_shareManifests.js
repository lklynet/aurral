import {
  getInstance,
  INSTANCE_ID_PATTERN,
  SHARE_TOKEN_PATTERN,
  TUNNEL_URL_PATTERN,
} from "./_shareInstances.js";
import {
  MAX_SHARE_TRACKS,
  SHARE_CODE_PATTERN,
  parseShareManifest,
  parseShareTrack,
} from "../../lib/shareManifest.ts";

const schemaReady = new WeakMap();

async function ensureSchema(db) {
  if (!schemaReady.has(db)) {
    schemaReady.set(
      db,
      db
        .prepare(`CREATE TABLE IF NOT EXISTS shares (
        instance_id TEXT NOT NULL,
        token TEXT NOT NULL,
        manifest TEXT NOT NULL,
        share_files INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (instance_id, token)
      )`)
        .run()
        .then(() =>
          db
            .prepare(
              "CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_public_code ON shares (substr(token, 1, 15))",
            )
            .run(),
        )
        .catch((error) => {
          schemaReady.delete(db);
          throw error;
        }),
    );
  }
  await schemaReady.get(db);
}

function readManifest(row) {
  if (!row) return null;
  const manifest = parseShareManifest(JSON.parse(row.manifest));
  return manifest ? { manifest, shareFiles: row.share_files === 1 } : null;
}

export async function getShareManifest(db, id, token) {
  if (!db || !INSTANCE_ID_PATTERN.test(id) || !SHARE_TOKEN_PATTERN.test(token)) return null;
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT manifest, share_files FROM shares WHERE instance_id = ? AND token = ?")
    .bind(id, token)
    .first();
  return readManifest(row);
}

export async function getHostedShare(db, segment) {
  if (!db) return null;
  if (SHARE_CODE_PATTERN.test(segment)) {
    await ensureSchema(db);
    const row = await db
      .prepare(
        "SELECT instance_id, token, manifest, share_files FROM shares WHERE substr(token, 1, 15) = ?",
      )
      .bind(segment.slice(1))
      .first();
    const share = readManifest(row);
    return share ? { ...share, instanceId: row.instance_id, token: row.token } : null;
  }
  const [instanceId, token, extra] = String(segment || "").split(".");
  if (extra || !INSTANCE_ID_PATTERN.test(instanceId) || !SHARE_TOKEN_PATTERN.test(token))
    return null;
  const share = await getShareManifest(db, instanceId, token);
  return share ? { ...share, instanceId, token } : null;
}

export async function saveShareManifest(db, id, token, manifest, shareFiles) {
  await ensureSchema(db);
  await db
    .prepare(`INSERT INTO shares (instance_id, token, manifest, share_files, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (instance_id, token) DO UPDATE SET
    manifest = excluded.manifest, share_files = excluded.share_files, updated_at = excluded.updated_at`)
    .bind(id, token, JSON.stringify(manifest), shareFiles ? 1 : 0, Date.now())
    .run();
}

export async function deleteShareManifest(db, id, token) {
  await ensureSchema(db);
  await db
    .prepare(
      "UPDATE shares SET manifest = 'null', share_files = 0, updated_at = ? WHERE instance_id = ? AND token = ?",
    )
    .bind(Date.now(), id, token)
    .run();
}

export async function loadSharedFiles(db, id, token) {
  try {
    const instance = await getInstance(db, id);
    if (!TUNNEL_URL_PATTERN.test(instance?.tunnel_url || "")) return null;
    const base = `${instance.tunnel_url}/share/${token}`;
    const response = await fetch(base, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const body = await response.json();
    if (!Array.isArray(body.tracks) || body.tracks.length > MAX_SHARE_TRACKS) return null;
    const tracks = body.tracks.map(parseShareTrack).filter((track) => track?.path);
    return tracks.length
      ? {
          base,
          kind: body.kind,
          allowDownload: body.allowDownload === true,
          expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null,
          tracks: tracks.map((track) => ({ ...track, url: `${base}/${track.path}` })),
        }
      : null;
  } catch {
    return null;
  }
}
