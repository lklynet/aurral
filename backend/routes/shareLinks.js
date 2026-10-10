import express from "express";
import { requireAuth, requireUserAccount } from "../middleware/requirePermission.js";
import { resolveShareTarget } from "../services/shareLinks/library.js";
import { syncShareListener } from "../services/shareLinks/shareListener.js";
import { getShareTunnelState, hasCloudflared } from "../services/shareLinks/tunnel.js";
import {
  createShareLink,
  deleteShareLink,
  listShareLinks,
  shareLinkUrl,
} from "../services/shareLinks/store.js";

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_OPTIONS = { "1d": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, never: null };
const KINDS = new Set(["track", "album", "artist"]);
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{4,700}$/;

const text = (value) => String(value ?? "").trim();

function targetFromInput(input) {
  const kind = text(input?.kind);
  if (!KINDS.has(kind)) return null;
  if (kind === "track") {
    const targetRef = text(input.libraryTrackId) || text(input.trackMbid);
    return targetRef ? { kind, targetRef, albumRef: text(input.libraryAlbumId) || null } : null;
  }
  if (kind === "album") {
    const targetRef = text(input.libraryAlbumId) || text(input.albumMbid);
    return targetRef ? { kind, targetRef, albumRef: null } : null;
  }
  const targetRef = text(input.artistMbid);
  return targetRef ? { kind, targetRef, albumRef: null } : null;
}

const toResponse = (link) => ({
  id: link.id,
  kind: link.kind,
  title: link.title,
  artistName: link.artistName,
  allowDownload: link.allowDownload,
  expiresAt: link.expiresAt,
  createdAt: link.createdAt,
  url: shareLinkUrl(link),
});

const notInLibrary = (res) =>
  res.status(404).json({
    error: "not_in_library",
    message: "Nothing from this is in your Library yet, so there is nothing to play.",
  });

router.use(requireAuth, requireUserAccount);

router.get("/", (req, res) => {
  res.json({
    links: listShareLinks(Number(req.user.id)).map(toResponse),
    tunnel: getShareTunnelState(),
  });
});

router.get("/availability", async (req, res) => {
  const target = targetFromInput(req.query);
  if (!target) return res.status(400).json({ error: "invalid_request", message: "Choose what to share." });
  res.json({
    trackCount: resolveShareTarget(target)?.tracks.length || 0,
    tunnelAvailable: await hasCloudflared(),
  });
});

router.post("/", async (req, res) => {
  const target = targetFromInput(req.body);
  if (!target) return res.status(400).json({ error: "invalid_request", message: "Choose what to share." });
  const payload = text(req.body?.payload);
  if (!PAYLOAD_PATTERN.test(payload)) {
    return res.status(400).json({ error: "invalid_request", message: "The share link is incomplete.", field: "payload" });
  }
  const expiresIn = text(req.body?.expiresIn);
  if (!Object.hasOwn(EXPIRY_OPTIONS, expiresIn)) {
    return res.status(400).json({ error: "invalid_request", message: "Choose when the link expires.", field: "expiresIn" });
  }
  const resolved = resolveShareTarget(target);
  if (!resolved) return notInLibrary(res);
  if (!(await hasCloudflared())) {
    return res.status(503).json({
      error: "tunnel_unavailable",
      message: "cloudflared is not installed, so friends could not reach this link.",
    });
  }
  const duration = EXPIRY_OPTIONS[expiresIn];
  const link = createShareLink({
    ...target,
    userId: Number(req.user.id),
    payload,
    title: resolved.title,
    artistName: resolved.artistName,
    allowDownload: req.body?.allowDownload === true,
    expiresAt: duration == null ? null : Date.now() + duration,
  });
  await syncShareListener();
  res.status(201).json({ link: toResponse(link) });
});

router.delete("/:id", async (req, res) => {
  if (!deleteShareLink(Number(req.user.id), req.params.id)) {
    return res.status(404).json({ error: "not_found", message: "This link was already stopped." });
  }
  await syncShareListener();
  res.status(204).end();
});

export default router;
