import { getRequestListener } from "@hono/node-server";
import { create as contentDisposition } from "content-disposition";
import { Hono, type Context } from "hono";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { asAppError } from "../../../lib/errors.ts";
import { userOps } from "../../db/helpers/index.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { sendViaNode } from "../../routes/shared/sendViaNode.ts";
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
type ZipPlan = Awaited<ReturnType<typeof planZip>>;

const notFound = (c: Context<AppEnv>) =>
  c.json({ error: "not_found", message: "This link has expired or was stopped." }, 404);

function loadShare(token: string) {
  const link = getLiveShareLink(token);
  const owner = link ? userOps.getUserById(link.userId) : null;
  const target = link && owner?.status === "active" ? resolveShareTarget(link) : null;
  return link && target ? { link, target } : null;
}

const findTrack = (target: ResolvedShareTarget, albumId: string, trackId: string) =>
  target.tracks.find(
    (track) => track.albumId === Number(albumId) && track.trackId === Number(trackId),
  ) || null;

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

async function sendZip(req: IncomingMessage, res: ServerResponse, plan: ZipPlan) {
  res.setHeader("Content-Length", String(plan.totalSize));
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  const body = zipStream(plan);
  body.on("error", (error) => {
    logger.warn("share", "Share download stopped:", { message: error.message });
    res.destroy(error);
  });
  res.on("close", () => body.destroy());
  body.pipe(res);
  return true;
}

async function sendDownload(c: Context<AppEnv>, track: ResolvedShareTrack) {
  c.header("Content-Disposition", contentDisposition(path.basename(track.file.path)));
  return (await sendViaNode(c, sendAudioFile, track.file.path)) || notFound(c);
}

export function createShareApp() {
  return new Hono<AppEnv>({ strict: false })
    .use(async (c, next) => {
      c.header("Access-Control-Allow-Origin", "*");
      c.header(
        "Access-Control-Expose-Headers",
        "Content-Length, Content-Range, Content-Disposition",
      );
      c.header("Cache-Control", "no-store");
      c.header("Cross-Origin-Resource-Policy", "cross-origin");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Content-Type-Options", "nosniff");
      if (c.req.method === "OPTIONS") {
        c.header("Access-Control-Allow-Methods", "GET, HEAD");
        c.header("Access-Control-Allow-Headers", "Range");
        return c.body(null, 204);
      }
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        c.header("Allow", "GET, HEAD");
        return c.json({ error: "method_not_allowed" }, 405);
      }
      await next();
    })
    .get("/share/.well-known/aurral", (c) => c.json({ instanceId: getShareInstance().id }))
    .get("/share/:token", (c) => {
      const share = loadShare(c.req.param("token"));
      if (!share) return notFound(c);
      const { link, target } = share;
      return c.json({
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
    })
    .get("/share/:token/tracks/:albumId/:trackId/stream", async (c) => {
      const share = loadShare(c.req.param("token"));
      const track =
        share && findTrack(share.target, c.req.param("albumId"), c.req.param("trackId"));
      if (!track) return notFound(c);
      const served = playsInBrowsers(track.file)
        ? await sendViaNode(c, sendAudioFile, track.file.path)
        : await sendViaNode(c, streamSubsonicAudio, track.file.path, {
            format: "mp3",
            maxBitRate: 320,
          });
      return served || notFound(c);
    })
    .get("/share/:token/tracks/:albumId/:trackId/download", async (c) => {
      const share = loadShare(c.req.param("token"));
      if (!share?.link.allowDownload) return notFound(c);
      const track = findTrack(share.target, c.req.param("albumId"), c.req.param("trackId"));
      return track ? sendDownload(c, track) : notFound(c);
    })
    .get("/share/:token/download", async (c) => {
      const share = loadShare(c.req.param("token"));
      if (!share?.link.allowDownload) return notFound(c);
      const { link, target } = share;
      if (link.kind === "track") return sendDownload(c, target.tracks[0]);
      const plan = await planZip(zipEntries(link, target));
      const zipName =
        link.kind === "artist" ? target.title : `${target.artistName} - ${target.title}`;
      c.header("Content-Type", "application/zip");
      c.header("Content-Disposition", contentDisposition(`${safeSegment(zipName)}.zip`));
      return (await sendViaNode(c, sendZip, plan)) || notFound(c);
    })
    .notFound(notFound)
    .onError((error, c) => {
      logger.error("share", "Share request failed:", { message: asAppError(error)?.message });
      return c.json({ error: "internal_error" }, 500);
    });
}

let server: Server | null = null;
let expiryTimer: NodeJS.Timeout | null = null;
let syncing = Promise.resolve();

function listen() {
  return new Promise<Server>((resolve, reject) => {
    const next = createServer(
      getRequestListener(createShareApp().fetch, { overrideGlobalObjects: false }),
    );
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
