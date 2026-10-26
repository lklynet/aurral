import { MAX_SHARE_BYTES, parseShareManifest } from "../../../../../lib/shareManifest.ts";
import {
  authorizeShareInstance,
  INSTANCE_ID_PATTERN,
  SHARE_TOKEN_PATTERN,
} from "../../../_shareInstances.js";
import {
  deleteShareManifest,
  getShareManifest,
  saveShareManifest,
} from "../../../_shareManifests.js";

const reply = (status, body) =>
  new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function onRequest({ request, params, env }) {
  const { id, token } = params;
  if (!INSTANCE_ID_PATTERN.test(id) || !SHARE_TOKEN_PATTERN.test(token))
    return reply(400, { error: "invalid_request" });
  const db = env?.SHARE_DB;
  if (!db) return reply(503, { error: "sharing_unavailable" });
  if (request.method === "GET") {
    const share = await getShareManifest(db, id, token);
    return share ? reply(200, share) : reply(404, { error: "not_found" });
  }
  if (request.method !== "PUT" && request.method !== "DELETE")
    return reply(405, { error: "method_not_allowed" });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_SHARE_BYTES)
    return reply(413, { error: "share_too_large" });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "invalid_request" });
  }
  if (!body || typeof body !== "object") return reply(400, { error: "invalid_request" });
  const manifest = request.method === "PUT" ? parseShareManifest(body.manifest) : null;
  if (request.method === "PUT" && !manifest) return reply(400, { error: "invalid_manifest" });
  if (!(await authorizeShareInstance(db, id, String(body.secret || ""))))
    return reply(403, { error: "wrong_secret" });
  if (request.method === "DELETE") await deleteShareManifest(db, id, token);
  else {
    try {
      await saveShareManifest(db, id, token, manifest, body.shareFiles === true);
    } catch (error) {
      if (String(error?.message || "").includes("idx_shares_public_code"))
        return reply(409, { error: "share_code_taken" });
      throw error;
    }
  }
  return reply(204);
}
