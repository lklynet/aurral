import express from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getLastfmApiKey, getLastfmApiSecret, lastfmGetSession, listenbrainzValidateToken } from "../services/apiClients/index.js";
import { userOps } from "../db/helpers/index.js";
import { requireAuth } from "../middleware/requirePermission.js";
import { validateExternalUrl } from "../middleware/urlValidator.js";
import { normalizeKoitoBaseUrl } from "../services/koitoClient.js";
import { getScrobbleEncryptionKey, scrobbleConnectionStore } from "../services/scrobbleConnectionStore.js";

const router = express.Router();
const encode = (value) => Buffer.from(value).toString("base64url");
const decode = (value) => Buffer.from(String(value || ""), "base64url").toString("utf8");

const createLinkToken = (userId) => {
  const payload = `${userId}.${Date.now() + 10 * 60 * 1000}.${randomBytes(12).toString("hex")}`;
  const signature = createHmac("sha256", getScrobbleEncryptionKey()).update(payload).digest("base64url");
  return `${encode(payload)}.${signature}`;
};

const verifyLinkToken = (token) => {
  const [encodedPayload, signature] = String(token || "").split(".");
  if (!encodedPayload || !signature) return null;
  const payload = decode(encodedPayload);
  const expected = createHmac("sha256", getScrobbleEncryptionKey()).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const [userId, expiresAt] = payload.split(".");
  if (!Number.isFinite(Number(userId)) || Number(expiresAt) <= Date.now()) return null;
  return Math.trunc(Number(userId));
};

const callbackUrl = (req, token) => {
  const protocol = String(req.get("x-forwarded-proto") || req.protocol).split(",")[0].trim();
  return `${protocol}://${req.get("host")}/api/scrobbling/lastfm/link/callback?uid=${encode(token)}`;
};

router.get("/status", requireAuth, (req, res) => {
  const status = scrobbleConnectionStore.getPublicStatus(req.user.id);
  status.lastfm.configured = Boolean(getLastfmApiKey() && getLastfmApiSecret());
  res.json(status);
});

router.get("/lastfm/link", requireAuth, (req, res) => {
  const configured = Boolean(getLastfmApiKey() && getLastfmApiSecret());
  if (!configured) {
    return res.status(400).json({ error: "Last.fm API key and secret are required first." });
  }
  const token = createLinkToken(req.user.id);
  res.json({
    configured: true,
    connected: scrobbleConnectionStore.getConnection(req.user.id, "lastfm") != null,
    authorizeUrl: `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(getLastfmApiKey())}&cb=${encodeURIComponent(callbackUrl(req, token))}`,
  });
});

router.get("/lastfm/link/callback", async (req, res) => {
  try {
    const userId = verifyLinkToken(req.query.uid);
    const token = String(req.query.token || "").trim();
    if (!userId || !token) return res.status(400).send("Invalid Last.fm link request");
    const session = await lastfmGetSession(token);
    const key = session?.session?.key;
    if (!key) return res.status(400).send("Last.fm did not return a session");
    scrobbleConnectionStore.saveConnection(userId, "lastfm", {
      token: key,
      displayName: session.session.name,
    });
    return res.type("html").send("<p>Last.fm connected. You can close this window.</p>");
  } catch {
    return res.status(400).send("Last.fm connection failed");
  }
});

router.delete("/lastfm/link", requireAuth, (req, res) => {
  scrobbleConnectionStore.deleteConnection(req.user.id, "lastfm");
  res.status(204).end();
});

router.get("/listenbrainz/link", requireAuth, (req, res) => {
  const connection = scrobbleConnectionStore.getConnection(req.user.id, "listenbrainz");
  res.json({ connected: Boolean(connection), displayName: connection?.displayName || null });
});

router.put("/listenbrainz/link", requireAuth, async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ error: "Token is required" });
    const validation = await listenbrainzValidateToken(token);
    if (!validation?.valid) return res.status(400).json({ error: "Invalid token" });
    const connection = scrobbleConnectionStore.saveConnection(req.user.id, "listenbrainz", {
      token,
      displayName: validation.user_name,
    });
    return res.json({ connected: true, displayName: connection.displayName });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Could not validate token" });
  }
});

router.delete("/listenbrainz/link", requireAuth, (req, res) => {
  scrobbleConnectionStore.deleteConnection(req.user.id, "listenbrainz");
  res.status(204).end();
});

router.put("/koito/link", requireAuth, (req, res) => {
  const rawUrl = String(req.body?.url || userOps.getUserById(req.user.id)?.listenHistoryUrl || "").trim();
  const validation = validateExternalUrl(rawUrl);
  const token = String(req.body?.token || "").trim();
  if (!validation.valid || !token) return res.status(400).json({ error: validation.error || "Token is required" });
  const connection = scrobbleConnectionStore.saveConnection(req.user.id, "koito", {
    token,
    baseUrl: normalizeKoitoBaseUrl(validation.url),
    displayName: normalizeKoitoBaseUrl(validation.url),
  });
  res.json({ connected: true, displayName: connection.displayName });
});

router.delete("/koito/link", requireAuth, (req, res) => {
  scrobbleConnectionStore.deleteConnection(req.user.id, "koito");
  res.status(204).end();
});

export default router;
