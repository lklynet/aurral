import { asAppError } from "../../../lib/errors.ts";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { userOps } from "../../db/helpers/index.ts";
import { sendAudioFile } from "../audioFileStream.ts";
import { logger } from "../logger.ts";
import { streamSubsonicAudio } from "../subsonicTranscodeService.ts";
import { playsInBrowsers, resolveShareTarget } from "./library.ts";
import { getLiveShareLink, getShareInstance, getShareLinkSchedule } from "./store.ts";
import { startShareTunnel, stopShareTunnel } from "./tunnel.ts";
import { planZip, zipStream } from "./zipStream.ts";

declare function clearTimeout(timeout: NodeJS.Timeout | string | number | null | undefined): void;

const MAX_TIMER_MS = 6 * 60 * 60 * 1000;

type LiveShareLink = NonNullable<ReturnType<typeof getLiveShareLink>>;
type ResolvedShareTarget = NonNullable<ReturnType<typeof resolveShareTarget>>;
type ResolvedShareTrack = ResolvedShareTarget["tracks"][number];

const notFound = (res: Response) =>
  res.status(404).json({ error: "not_found", message: "This link has expired or was stopped." });

function loadShare(req: Request<{ token?: string }>, res: Response) {
  const link = getLiveShareLink(req.params.token);
  const owner = link ? userOps.getUserById(link.userId) : null;
  const target = owner?.status === "active" ? resolveShareTarget(link!) : null;
  if (!target) {
    notFound(res);
    return null;
  }
  return { link, target } as {
    link: LiveShareLink;
    target: typeof target;
  };
}

function findTrack(target: ResolvedShareTarget, req: Request) {
  const albumId = Number(req.params.albumId);
  const trackId = Number(req.params.trackId);
  return (
    target.tracks.find((track) => track.albumId === albumId && track.trackId === trackId) || null
  );
}

const safeSegment = (value: string | null | undefined) =>
  String(value || "")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120) || "Untitled";

function zipEntries(link: LiveShareLink, target: ResolvedShareTarget) {
  const used = new Set();
  return target.tracks.map((track) => {
    const folder =
      link.kind === "artist"
        ? `${safeSegment(target.title)}/${safeSegment(track.albumTitle)}`
        : safeSegment(`${target.artistName} - ${target.title}`);
    const parsed = path.parse(track.file.path);
    let name = `${folder}/${safeSegment(parsed.name)}${parsed.ext}`;
    for (let copy = 2; used.has(name.toLowerCase()); copy += 1) {
      name = `${folder}/${safeSegment(parsed.name)} (${copy})${parsed.ext}`;
    }
    used.add(name.toLowerCase());
    return { name, path: track.file.path };
  });
}

async function sendDownload(req: Request, res: Response, track: ResolvedShareTrack) {
  res.attachment(path.basename(track.file.path));
  if (!(await sendAudioFile(req, res, track.file.path))) notFound(res);
}

export function createShareApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  app.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Disposition",
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "OPTIONS") {
      res.set({
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Allow-Headers": "Range",
      });
      return res.status(204).end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(405).set("Allow", "GET, HEAD").json({ error: "method_not_allowed" });
    }
    return next();
  });

  app.get("/share/.well-known/aurral", (req, res) => {
    res.json({ instanceId: getShareInstance().id });
  });

  app.get("/share/:token", (req, res) => {
    const share = loadShare(req, res);
    if (!share) return;
    const { link, target } = share;
    res.json({
      kind: link.kind,
      title: target.title,
      artistName: target.artistName,
      albumTitle: target.albumTitle,
      allowDownload: link.allowDownload,
      expiresAt: link.expiresAt,
      tracks: target.tracks.map((track) => ({
        path: `tracks/${track.albumId}/${track.trackId}`,
        title: track.title,
        artistName: track.artistName,
        albumTitle: track.albumTitle,
        discNumber: track.discNumber,
        trackNumber: track.trackNumber,
        durationMs: track.durationMs,
        format: track.file.format,
        size: track.file.size,
      })),
    });
  });

  app.get("/share/:token/tracks/:albumId/:trackId/stream", async (req, res, next) => {
    try {
      const share = loadShare(req, res);
      if (!share) return;
      const track = findTrack(share.target, req);
      if (!track) return notFound(res);
      const served = playsInBrowsers(track.file)
        ? await sendAudioFile(req, res, track.file.path)
        : await streamSubsonicAudio(req, res, track.file.path, { format: "mp3", maxBitRate: 320 });
      if (!served) notFound(res);
    } catch (error) {
      next(error);
    }
  });

  app.get("/share/:token/tracks/:albumId/:trackId/download", async (req, res, next) => {
    try {
      const share = loadShare(req, res);
      if (!share) return;
      if (!share.link.allowDownload) return notFound(res);
      const track = findTrack(share.target, req);
      if (!track) return notFound(res);
      await sendDownload(req, res, track);
    } catch (error) {
      next(error);
    }
  });

  app.get("/share/:token/download", async (req, res, next) => {
    try {
      const share = loadShare(req, res);
      if (!share) return;
      const { link, target } = share;
      if (!link.allowDownload) return notFound(res);
      if (link.kind === "track") return await sendDownload(req, res, target.tracks[0]);
      const plan = await planZip(zipEntries(link, target));
      const zipName =
        link.kind === "artist" ? target.title : `${target.artistName} - ${target.title}`;
      res.attachment(`${safeSegment(zipName)}.zip`);
      res.set("Content-Length", String(plan.totalSize));
      if (req.method === "HEAD") return res.end();
      const body = zipStream(plan);
      body.on("error", (error) => {
        logger.warn("share", "Share download stopped:", { message: error.message });
        res.destroy(error);
      });
      res.on("close", () => body.destroy());
      body.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => notFound(res));

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    logger.error("share", "Share request failed:", { message: asAppError(error)?.message });
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: "internal_error" });
  });

  return app;
}

let server: Server | null = null;
let expiryTimer: NodeJS.Timeout | null = null;
let syncing = Promise.resolve();

function listen() {
  return new Promise<Server>((resolve, reject) => {
    const next = createServer(createShareApp());
    next.once("error", reject);
    next.listen(0, "127.0.0.1", () => {
      next.off("error", reject);
      resolve(next);
    });
  });
}

function close(current: Server) {
  return new Promise<void>((resolve) => {
    current.close(() => resolve());
    current.closeAllConnections();
  });
}

function scheduleExpiry(nextExpiresAt: number | null) {
  clearTimeout(expiryTimer);
  expiryTimer = null;
  if (nextExpiresAt == null) return;
  const delay = Math.min(Math.max(nextExpiresAt - Date.now(), 0) + 1000, MAX_TIMER_MS);
  expiryTimer = setTimeout(() => void syncShareListener(), delay);
  expiryTimer.unref();
}

async function applySchedule() {
  const { count, nextExpiresAt } = getShareLinkSchedule();
  if (count > 0) {
    if (!server) {
      server = await listen();
      logger.info(
        "share",
        `Share listener running on 127.0.0.1:${(server.address() as AddressInfo).port}`,
      );
    }
    startShareTunnel((server.address() as AddressInfo).port);
  } else if (server) {
    const current = server;
    server = null;
    await stopShareTunnel();
    await close(current);
    logger.info("share", "Share listener stopped because no links are live");
  }
  scheduleExpiry(nextExpiresAt);
}

export function syncShareListener() {
  syncing = syncing.then(applySchedule).catch((error) => {
    logger.error("share", "Could not update the share listener:", { message: error.message });
  });
  return syncing;
}

export async function stopShareListener() {
  clearTimeout(expiryTimer);
  expiryTimer = null;
  await syncing;
  await stopShareTunnel();
  if (!server) return;
  const current = server;
  server = null;
  await close(current);
}
