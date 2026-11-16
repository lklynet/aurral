import type { D1Database } from "@cloudflare/workers-types/index.ts";

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameHash(left: string, right: string) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < right.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function authorizeInstance(db: D1Database, id: string, secret: string) {
  if (!INSTANCE_ID_PATTERN.test(id) || !SECRET_PATTERN.test(secret)) return false;
  const secretHash = await sha256Hex(secret);
  await db
    .prepare(
      "INSERT INTO instances (id, secret_hash, tunnel_url, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT (id) DO NOTHING",
    )
    .bind(id, secretHash, Date.now())
    .run();
  const stored = await db
    .prepare("SELECT secret_hash FROM instances WHERE id = ?")
    .bind(id)
    .first<string>("secret_hash");
  return stored !== null && sameHash(stored, secretHash);
}
