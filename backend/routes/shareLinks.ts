import express from "express";
import type { Response } from "express";
import { requireAuth, requireUserAccount } from "../middleware/requirePermission.ts";
import { hasPermission } from "../middleware/auth.ts";
import { flowPlaylistConfig } from "../services/playlists/flowPlaylistConfig.ts";
import { resolveShareManifest } from "../services/shareLinks/metadata.ts";
import {
  createPlainShare,
  publishDetailsShare,
  publishShareManifest,
} from "../services/shareLinks/hosting.ts";
import { randomUUID } from "node:crypto";
import { asAppError } from "../../lib/errors.ts";
import { loadRemoteShare } from "../services/shareLinks/remote.ts";
import {
  enqueueImportedPlaylist,
  sharedPlaylistTracks,
} from "../services/importLists/importPlaylist.ts";
import { shareDestination } from "../services/shareLinks/open.ts";
import { findShareLocalFiles } from "../services/shareLinks/import.ts";
import { playlistOperationQueue } from "../services/playlists/playlistOperationQueue.ts";
import type { RequestUser } from "../middleware/requestUser.ts";
import { resolveShareTarget } from "../services/shareLinks/library.ts";
import { getLibraryForTrackMatches } from "../services/libraryQueryService.ts";
import { findSharedTrack, MAX_SHARE_BYTES, withoutShareFiles } from "../../lib/shareManifest.ts";
import { syncShareListener } from "../services/shareLinks/shareListener.ts";
import { getShareTunnelState, hasCloudflared } from "../services/shareLinks/tunnel.ts";
import {
  createShareLink,
  revokeShareFiles,
  deleteShareLink,
  listShareLinks,
  shareLinkUrl,
} from "../services/shareLinks/store.ts";

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_OPTIONS = { "1d": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, never: null };
const KINDS = new Set(["track", "album", "artist", "playlist"]);
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{4,700}$/;

type ShareLink = NonNullable<ReturnType<typeof createShareLink>>;

type ShareTargetBody = {
  kind?: unknown;
  libraryTrackId?: unknown;
  trackMbid?: unknown;
  libraryAlbumId?: unknown;
  albumMbid?: unknown;
  libraryArtistId?: unknown;
  artistMbid?: unknown;
  playlistId?: unknown;
  title?: unknown;
  artistName?: unknown;
  albumTitle?: unknown;
};

const text = (value: unknown) => String(value ?? "").trim();

function targetFromInput(input: ShareTargetBody | undefined, allowMetadata = false) {
  const kind = text(input?.kind);
  if (!KINDS.has(kind)) return null;
  if (kind === "playlist") {
    const targetRef = text(input?.playlistId);
    return targetRef ? { kind, targetRef, albumRef: null } : null;
  }
  if (kind === "track") {
    if (
      allowMetadata &&
      !input?.libraryTrackId &&
      (input?.trackMbid || (input?.title && input.artistName))
    ) {
      const library = getLibraryForTrackMatches({
        titles: [text(input.title)],
        mbids: [text(input.trackMbid)],
        availableOnly: true,
      });
      const match = library.tracks.find(
        (track) =>
          (input.trackMbid
            ? track.mbid === text(input.trackMbid)
            : track.title.toLowerCase() === text(input.title).toLowerCase() &&
              track.artistName?.toLowerCase() === text(input.artistName).toLowerCase()) &&
          ((!input.albumMbid && !input.albumTitle) ||
            track.albums.some((entry) =>
              library.albums.some(
                (album) =>
                  album.id === entry.albumId &&
                  (input.albumMbid
                    ? album.releaseGroupMbid === text(input.albumMbid)
                    : album.title.toLowerCase() === text(input.albumTitle).toLowerCase()),
              ),
            )),
      );
      if (match) {
        const album = library.albums.find(
          (album) =>
            match.albums.some((entry) => entry.albumId === album.id) &&
            (input.albumMbid
              ? album.releaseGroupMbid === text(input.albumMbid)
              : input.albumTitle
                ? album.title.toLowerCase() === text(input.albumTitle).toLowerCase()
                : true),
        );
        return { kind, targetRef: String(match.id), albumRef: album ? String(album.id) : null };
      }
    }
    const targetRef =
      text(input!.libraryTrackId) || text(input!.trackMbid) || (allowMetadata ? "metadata" : "");
    return targetRef ? { kind, targetRef, albumRef: text(input!.libraryAlbumId) || null } : null;
  }
  if (kind === "album") {
    const targetRef =
      text(input!.libraryAlbumId) || text(input!.albumMbid) || (allowMetadata ? "metadata" : "");
    return targetRef ? { kind, targetRef, albumRef: null } : null;
  }
  const targetRef =
    text(input!.libraryArtistId) || text(input!.artistMbid) || (allowMetadata ? "metadata" : "");
  return targetRef ? { kind, targetRef, albumRef: null } : null;
}

const toResponse = (link: ShareLink) => ({
  id: link.id,
  kind: link.kind,
  title: link.title,
  artistName: link.artistName,
  allowDownload: link.allowDownload,
  expiresAt: link.expiresAt,
  createdAt: link.createdAt,
  url: shareLinkUrl(link),
  shareFiles: link.shareFiles,
});

export type ShareLinkResponse = ReturnType<typeof toResponse>;

const notInLibrary = (res: Response) =>
  res.status(404).json({
    error: "not_in_library",
    message: "No Library tracks available to share.",
  });

router.use(requireAuth);

router.post("/plain", async (req, res) => {
  try {
    return res.status(201).json({ link: await createPlainShare(req.body?.manifest) });
  } catch (error) {
    return res.status(400).json({
      error: "share_unavailable",
      message: asAppError(error)?.message || "Could not create the share. Try again.",
    });
  }
});

export type PlainShareLinkCreatedResponse = { link: Awaited<ReturnType<typeof createPlainShare>> };

router.post("/open", async (req, res) => {
  try {
    const share = await loadRemoteShare(req.body?.url);
    return res.json({ to: shareDestination(share.manifest) });
  } catch (error) {
    return res.status(400).json({
      error: "share_unavailable",
      message: asAppError(error)?.message || "Could not open the share. Try again.",
    });
  }
});

export type ShareOpenResponse = { to: string };

router.use(requireUserAccount);

function canImport(user: RequestUser | undefined, kind: string) {
  return hasPermission(
    user,
    kind === "playlist" ? "accessFlow" : kind === "artist" ? "addArtist" : "addAlbum",
  );
}

async function previewImport(url: unknown) {
  const share = await loadRemoteShare(url);
  const localFiles = findShareLocalFiles(share.manifest.tracks);
  const tracks = share.manifest.tracks.map((track, index) => {
    const file = track.path
      ? share.files?.tracks.find((entry) => track.path === entry.path)
      : findSharedTrack(share.files?.tracks || [], track);
    return { ...track, available: Boolean(file), inLibrary: Boolean(localFiles[index]) };
  });
  return {
    url: share.url,
    manifest: share.manifest,
    tracks,
    canDownload: Boolean(share.files),
    ready: tracks.filter((track) => track.inLibrary).length,
    downloads: tracks.filter((track) => !track.inLibrary && track.available).length,
    detailsOnly: tracks.filter((track) => !track.inLibrary && !track.available).length,
    downloadBytes: tracks.reduce(
      (sum, track) => sum + (!track.inLibrary && track.available ? track.size || 0 : 0),
      0,
    ),
  };
}

export type ShareImportPreviewResponse = Awaited<ReturnType<typeof previewImport>>;

router.post("/import/preview", async (req, res) => {
  try {
    const preview = await previewImport(req.body?.url);
    if (!canImport(req.user, preview.manifest.kind))
      return res
        .status(403)
        .json({ error: "forbidden", message: "Your account cannot import this item." });
    return res.json(preview);
  } catch (error) {
    return res.status(400).json({
      error: "share_unavailable",
      message: asAppError(error)?.message || "Could not load the share. Try again.",
    });
  }
});

router.post("/import", async (req, res) => {
  try {
    const preview = await previewImport(req.body?.url);
    const includeFiles = req.body?.includeFiles === true;
    const sync = req.body?.sync === true;
    const name = text(req.body?.name) || preview.manifest.title;
    if (
      !canImport(req.user, preview.manifest.kind) ||
      (includeFiles && preview.manifest.kind !== "playlist" && !hasPermission(req.user, "addAlbum"))
    )
      return res
        .status(403)
        .json({ error: "forbidden", message: "Your account cannot import this item." });
    if (sync) {
      if (preview.manifest.kind !== "playlist")
        return res
          .status(400)
          .json({ error: "invalid_request", message: "Only playlists can stay synced." });
      const result = await enqueueImportedPlaylist({
        ownerUserId: req.user!.id,
        name,
        sourceName: "Aurral share",
        provider: "aurral-share",
        externalId: preview.url,
        externalName: preview.manifest.title,
        tracks: sharedPlaylistTracks(preview.manifest),
        syncEnabled: true,
        syncIntervalHours: 24,
        keepRemovedTracks: true,
      });
      return res.status(202).json({
        queued: true,
        operationId: result.operationId,
        to: `/library/playlists/${result.playlistId}`,
      });
    }
    if (includeFiles && !preview.canDownload)
      return res.status(409).json({
        error: "files_unavailable",
        message:
          "Shared files are unavailable. Import details instead, or try again when the share is online.",
      });
    const playlistId = randomUUID();
    const result = await playlistOperationQueue.enqueuePayload({
      kind: "share-import",
      label: `share-import:${playlistId}`,
      playlistId,
      url: preview.url,
      manifest: preview.manifest,
      includeFiles,
      name,
      ownerUserId: req.user!.id,
    });
    return res.status(202).json({
      queued: true,
      operationId: result.operationId,
      to: preview.manifest.kind === "playlist" ? `/library/playlists/${playlistId}` : "/library",
    });
  } catch (error) {
    return res.status(400).json({
      error: "share_unavailable",
      message: asAppError(error)?.message || "Could not import the share. Try again.",
    });
  }
});

export type ShareImportQueuedResponse = { queued: true; operationId: string; to: string };

export type ShareImportRequest = {
  url: string;
  includeFiles?: boolean;
  sync?: boolean;
  name?: string;
};

router.get("/", (req, res) => {
  res.json({
    links: listShareLinks(Number(req.user!.id)).map(toResponse),
    tunnel: getShareTunnelState(),
  });
});

router.get("/availability", async (req, res) => {
  const target = targetFromInput(req.query, true);
  if (!target)
    return res.status(400).json({ error: "invalid_request", message: "Choose what to share." });
  if (
    target.kind === "playlist" &&
    (!hasPermission(req.user, "accessFlow") ||
      !flowPlaylistConfig.getStaticPlaylistForUser(req.user, target.targetRef))
  )
    return res.status(404).json({ error: "not_found", message: "Playlist not found." });
  res.json({
    trackCount: resolveShareTarget(target)?.tracks.length || 0,
    tunnelAvailable: await hasCloudflared(),
    totalTracks:
      target.kind === "playlist"
        ? flowPlaylistConfig.getStaticPlaylist(target.targetRef)?.tracks.length || 0
        : null,
  });
});

router.post("/", async (req, res) => {
  const hosted = req.body?.manifest !== undefined;
  const target = targetFromInput(req.body, hosted);
  if (!target)
    return res.status(400).json({ error: "invalid_request", message: "Choose what to share." });
  const payload = text(req.body?.payload);
  if (!hosted && !PAYLOAD_PATTERN.test(payload)) {
    return res.status(400).json({
      error: "invalid_request",
      message: "The share link is incomplete.",
      field: "payload",
    });
  }
  if (
    target.kind === "playlist" &&
    (!hasPermission(req.user, "accessFlow") ||
      !flowPlaylistConfig.getStaticPlaylistForUser(req.user, target.targetRef))
  )
    return res.status(404).json({ error: "not_found", message: "Playlist not found." });
  const shareFiles = hosted ? req.body?.shareFiles === true : true;
  let manifest = hosted ? resolveShareManifest(target, req.body.manifest) : null;
  if (hosted && (!manifest || manifest.kind !== target.kind))
    return res.status(400).json({
      error: "invalid_manifest",
      message: "The share is incomplete or contains too many tracks.",
    });
  if (manifest && !shareFiles) manifest = withoutShareFiles(manifest);
  if (manifest && Buffer.byteLength(JSON.stringify(manifest)) > MAX_SHARE_BYTES - 1024)
    return res.status(400).json({
      error: "share_too_large",
      message: "This share is too large. Share a smaller selection.",
    });
  if (manifest && !shareFiles && target.kind !== "playlist") {
    try {
      return res.status(201).json({ link: await publishDetailsShare(manifest) });
    } catch {
      return res.status(503).json({
        error: "sharing_unavailable",
        message: "Could not publish the share on aurral.org. Try again.",
      });
    }
  }
  const expiresIn = shareFiles ? text(req.body?.expiresIn) : "never";
  if (!Object.hasOwn(EXPIRY_OPTIONS, expiresIn)) {
    return res.status(400).json({
      error: "invalid_request",
      message: "Choose when the link expires.",
      field: "expiresIn",
    });
  }
  const resolved = resolveShareTarget(target);
  if (shareFiles && !resolved?.tracks.length) return notInLibrary(res);
  if (shareFiles && !(await hasCloudflared())) {
    return res.status(503).json({
      error: "tunnel_unavailable",
      message: "Install cloudflared on your server to share playback.",
    });
  }
  const duration = EXPIRY_OPTIONS[expiresIn as keyof typeof EXPIRY_OPTIONS];
  const link = createShareLink({
    ...target,
    userId: Number(req.user!.id),
    payload,
    title: manifest?.title || resolved!.title,
    artistName: manifest?.artistName ?? resolved!.artistName,
    allowDownload: shareFiles && req.body?.allowDownload === true,
    expiresAt: duration == null ? null : Date.now() + duration,
    manifest,
    shareFiles,
  });
  if (manifest) {
    try {
      await publishShareManifest(link.token, manifest, shareFiles);
    } catch {
      deleteShareLink(Number(req.user!.id), String(link.id));
      return res.status(503).json({
        error: "sharing_unavailable",
        message: "Could not publish the share on aurral.org. Try again.",
      });
    }
  }
  await syncShareListener();
  res.status(201).json({ link: toResponse(link) });
});

router.delete("/:id", async (req, res) => {
  const link = listShareLinks(Number(req.user!.id)).find(
    (entry) => String(entry.id) === req.params.id,
  );
  if (!link)
    return res.status(404).json({ error: "not_found", message: "This link was already stopped." });
  revokeShareFiles(Number(req.user!.id), req.params.id);
  await syncShareListener();
  if (link.manifest) {
    const keepDetails = link.kind !== "playlist";
    try {
      await publishShareManifest(link.token, keepDetails ? withoutShareFiles(link.manifest) : null);
    } catch {
      return res.status(503).json({
        error: "sharing_unavailable",
        message: keepDetails
          ? "Files stopped. Could not update the link on aurral.org. Try again."
          : "Files stopped. Could not remove the link from aurral.org. Try again.",
      });
    }
  }
  if (!deleteShareLink(Number(req.user!.id), req.params.id)) {
    return res.status(404).json({ error: "not_found", message: "This link was already stopped." });
  }
  res.status(204).end();
});

export type ShareLinksResponse = {
  links: ShareLinkResponse[];
  tunnel: ReturnType<typeof getShareTunnelState>;
};

export type ShareAvailabilityResponse = {
  trackCount: number;
  tunnelAvailable: boolean;
  totalTracks: number | null;
};

export type ShareLinkCreatedResponse = {
  link: ShareLinkResponse | Awaited<ReturnType<typeof publishDetailsShare>>;
};

export type ShareTargetInput = {
  kind?: string;
  libraryTrackId?: string;
  trackMbid?: string;
  libraryAlbumId?: string;
  albumMbid?: string;
  libraryArtistId?: string;
  artistMbid?: string;
  playlistId?: string;
  title?: string;
  artistName?: string;
  albumTitle?: string;
};

export type ShareLinkRequest = ShareTargetInput & {
  payload?: string | null;
  expiresIn: string;
  allowDownload?: boolean;
  shareFiles?: boolean;
  manifest?: unknown;
};

export default router;
