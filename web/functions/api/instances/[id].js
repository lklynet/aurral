import {
  getInstance,
  INSTANCE_ID_PATTERN,
  saveInstance,
  TUNNEL_URL_PATTERN,
} from "../../_shareInstances.js";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 1024;
const OWNERSHIP_TIMEOUT_MS = 8000;

const reply = (status, error) =>
  new Response(error ? JSON.stringify({ error }) : null, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameHash(left, right) {
  if (typeof left !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

async function tunnelAnswersFor(tunnelUrl, id) {
  try {
    const response = await fetch(`${tunnelUrl}/share/.well-known/aurral`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(OWNERSHIP_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.instanceId === id;
  } catch {
    return false;
  }
}

async function authorize(context) {
  const db = context.env.SHARE_DB;
  if (!db) return { response: reply(503, "lookup_unavailable") };
  const id = String(context.params.id || "");
  const body = await readBody(context.request);
  if (!INSTANCE_ID_PATTERN.test(id) || !body || !SECRET_PATTERN.test(String(body.secret || ""))) {
    return { response: reply(400, "invalid_request") };
  }
  const instance = await getInstance(db, id);
  const secretHash = await sha256Hex(body.secret);
  if (instance && !sameHash(instance.secret_hash, secretHash)) {
    return { response: reply(403, "wrong_secret") };
  }
  return { db, id, body, instance, secretHash };
}

export async function onRequestPut(context) {
  const auth = await authorize(context);
  if (auth.response) return auth.response;
  const tunnelUrl = String(auth.body.url || "");
  if (!TUNNEL_URL_PATTERN.test(tunnelUrl)) return reply(400, "invalid_tunnel_url");
  if (!(await tunnelAnswersFor(tunnelUrl, auth.id))) return reply(422, "tunnel_not_verified");
  const saved = await saveInstance(auth.db, { id: auth.id, secretHash: auth.secretHash, tunnelUrl });
  return saved ? reply(204) : reply(403, "wrong_secret");
}

export async function onRequestDelete(context) {
  const auth = await authorize(context);
  if (auth.response) return auth.response;
  if (auth.instance) {
    const saved = await saveInstance(auth.db, { id: auth.id, secretHash: auth.secretHash, tunnelUrl: null });
    if (!saved) return reply(403, "wrong_secret");
  }
  return reply(204);
}
