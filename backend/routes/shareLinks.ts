import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import * as v from "valibot";
import { hasPermission } from "../services/auth.ts";
import { requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv, RequestUser } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { asAppError } from "../../lib/errors.ts";
import { findSharedTrack, MAX_SHARE_BYTES, withoutShareFiles } from "../../lib/shareManifest.ts";
import {
  enqueueImportedPlaylist,
  sharedPlaylistTracks,
} from "../services/importLists/importPlaylist.ts";
import { getLibraryForTrackMatches } from "../services/libraryQueryService.ts";
import { flowPlaylistConfig } from "../services/playlists/flowPlaylistConfig.ts";
import { playlistOperationQueue } from "../services/playlists/playlistOperationQueue.ts";
import {
  createPlainShare,
  publishDetailsShare,
  publishShareManifest,
} from "../services/shareLinks/hosting.ts";
import { findShareLocalFiles } from "../services/shareLinks/import.ts";
import { resolveShareTarget } from "../services/shareLinks/library.ts";
import { resolveShareManifest } from "../services/shareLinks/metadata.ts";
import { shareDestination } from "../services/shareLinks/open.ts";
import { loadRemoteShare } from "../services/shareLinks/remote.ts";
import { syncShareListener } from "../services/shareLinks/shareListener.ts";
import { getShareTunnelState, hasCloudflared } from "../services/shareLinks/tunnel.ts";
import {
  createShareLink,
  deleteShareLink,
  listShareLinks,
  revokeShareFiles,
  shareLinkUrl,
} from "../services/shareLinks/store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_OPTIONS = { "1d": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, never: null };
const KINDS = new Set(["track", "album", "artist", "playlist"]);
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{4,700}$/;

type ShareLink = NonNullable<ReturnType<typeof createShareLink>>;

const ref = v.nullish(v.union([v.string(), v.number()]));
const targetQuery = v.object({
  kind: v.optional(v.string()),
  libraryTrackId: v.optional(v.string()),
  trackMbid: v.optional(v.string()),
  libraryAlbumId: v.optional(v.string()),
  albumMbid: v.optional(v.string()),
  libraryArtistId: v.optional(v.string()),
  artistMbid: v.optional(v.string()),
  playlistId: v.optional(v.string()),
  title: v.optional(v.string()),
  artistName: v.optional(v.string()),
  albumTitle: v.optional(v.string()),
});
const createInput = v.object({
  kind: v.nullish(v.string()),
  libraryTrackId: ref,
  trackMbid: ref,
  libraryAlbumId: ref,
  albumMbid: ref,
  libraryArtistId: ref,
  artistMbid: ref,
  playlistId: ref,
  title: ref,
  artistName: ref,
  albumTitle: ref,
  payload: v.nullish(v.string()),
  expiresIn: v.nullish(v.string()),
  allowDownload: v.nullish(v.boolean()),
  shareFiles: v.nullish(v.boolean()),
  manifest: v.optional(v.unknown()),
});
const shareUrl = v.object({ url: v.nullish(v.string()) });

type ShareTargetInput = Partial<v.InferOutput<typeof createInput>>;

const text = (value: unknown) => String(value ?? "").trim();
const sameText = (value: string | null | undefined, input: unknown) =>
  value?.toLowerCase() === text(input).toLowerCase();

function libraryTrackTarget(input: ShareTargetInput) {
  const library = getLibraryForTrackMatches({
    titles: [text(input.title)],
    mbids: [text(input.trackMbid)],
    availableOnly: true,
  });
  const matchesAlbum = (album: (typeof library.albums)[number]) =>
    input.albumMbid
      ? album.releaseGroupMbid === text(input.albumMbid)
      : sameText(album.title, input.albumTitle);
  const match = library.tracks.find(
    (track) =>
      (input.trackMbid
        ? track.mbid === text(input.trackMbid)
        : sameText(track.title, input.title) && sameText(track.artistName, input.artistName)) &&
      ((!input.albumMbid && !input.albumTitle) ||
        track.albums.some((entry) =>
          library.albums.some((album) => album.id === entry.albumId && matchesAlbum(album)),
        )),
  );
  if (!match) return null;
  const album = library.albums.find(
    (album) =>
      match.albums.some((entry) => entry.albumId === album.id) &&
      (input.albumMbid || input.albumTitle ? matchesAlbum(album) : true),
  );
  return { kind: "track", targetRef: String(match.id), albumRef: album ? String(album.id) : null };
}

function targetFromInput(input: ShareTargetInput, allowMetadata = false) {
  const kind = text(input.kind);
  if (!KINDS.has(kind)) return null;
  const metadata = allowMetadata ? "metadata" : "";
  if (kind === "playlist") {
    const targetRef = text(input.playlistId);
    return targetRef ? { kind, targetRef, albumRef: null } : null;
  }
  if (kind === "track") {
    const libraryTarget =
      allowMetadata &&
      !input.libraryTrackId &&
      (input.trackMbid || (input.title && input.artistName)) &&
      libraryTrackTarget(input);
    if (libraryTarget) return libraryTarget;
    const targetRef = text(input.libraryTrackId) || text(input.trackMbid) || metadata;
    return targetRef ? { kind, targetRef, albumRef: text(input.libraryAlbumId) || null } : null;
  }
  if (kind === "album") {
    const targetRef = text(input.libraryAlbumId) || text(input.albumMbid) || metadata;
    return targetRef ? { kind, targetRef, albumRef: null } : null;
  }
  const targetRef = text(input.libraryArtistId) || text(input.artistMbid) || metadata;
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

const canSharePlaylist = (user: RequestUser, playlistId: string) =>
  hasPermission(user, "accessPlaylists") &&
  Boolean(flowPlaylistConfig.getStaticPlaylistForUser(user, playlistId));

const canImport = (user: RequestUser, kind: string) =>
  hasPermission(
    user,
    kind === "playlist" ? "accessPlaylists" : kind === "artist" ? "addArtist" : "addAlbum",
  );

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

const invalidTarget = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: "invalid_request", message: "Choose what to share." }, 400);

const playlistNotFound = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: "not_found", message: "Playlist not found." }, 404);

const shareUnavailable = <E extends AppEnv>(c: Context<E>, error: unknown, fallback: string) =>
  c.json({ error: "share_unavailable", message: asAppError(error)?.message || fallback }, 400);

const cannotImport = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: "forbidden", message: "Your account cannot import this item." }, 403);

const publishFailed = <E extends AppEnv>(c: Context<E>, message: string) =>
  c.json({ error: "sharing_unavailable", message }, 503);

export default new Hono<AppEnv>()
  .basePath("/share-links")
  .use(requireAuth)
  .post("/plain", validate("json", v.object({ manifest: v.optional(v.unknown()) })), async (c) => {
    try {
      return c.json({ link: await createPlainShare(c.req.valid("json").manifest) }, 201);
    } catch (error) {
      return shareUnavailable(c, error, "Could not create the share. Try again.");
    }
  })
  .post("/open", validate("json", shareUrl), async (c) => {
    try {
      const share = await loadRemoteShare(c.req.valid("json").url);
      return c.json({ to: shareDestination(share.manifest) }, 200);
    } catch (error) {
      return shareUnavailable(c, error, "Could not open the share. Try again.");
    }
  })
  .use(requireUserAccount)
  .post("/import/preview", validate("json", shareUrl), async (c) => {
    try {
      const preview = await previewImport(c.req.valid("json").url);
      if (!canImport(c.var.user, preview.manifest.kind)) return cannotImport(c);
      return c.json(preview, 200);
    } catch (error) {
      return shareUnavailable(c, error, "Could not load the share. Try again.");
    }
  })
  .post(
    "/import",
    validate(
      "json",
      v.object({
        ...shareUrl.entries,
        includeFiles: v.nullish(v.boolean()),
        sync: v.nullish(v.boolean()),
        name: v.nullish(v.string()),
      }),
    ),
    async (c) => {
      const input = c.req.valid("json");
      const user = c.var.user;
      try {
        const preview = await previewImport(input.url);
        const { kind, title } = preview.manifest;
        const includeFiles = input.includeFiles === true;
        const name = text(input.name) || title;
        if (
          !canImport(user, kind) ||
          (includeFiles && kind !== "playlist" && !hasPermission(user, "addAlbum"))
        ) {
          return cannotImport(c);
        }
        if (input.sync === true) {
          if (kind !== "playlist") {
            return c.json(
              { error: "invalid_request", message: "Only playlists can stay synced." },
              400,
            );
          }
          const result = await enqueueImportedPlaylist({
            ownerUserId: user.id,
            name,
            sourceName: "Aurral share",
            provider: "aurral-share",
            externalId: preview.url,
            externalName: title,
            tracks: sharedPlaylistTracks(preview.manifest),
            syncEnabled: true,
            syncIntervalHours: 24,
            keepRemovedTracks: true,
          });
          return c.json(
            {
              queued: true,
              operationId: result.operationId,
              to: `/library/playlists/${result.playlistId}`,
            },
            202,
          );
        }
        if (includeFiles && !preview.canDownload) {
          return c.json(
            {
              error: "files_unavailable",
              message:
                "Shared files are unavailable. Import details instead, or try again when the share is online.",
            },
            409,
          );
        }
        const playlistId = randomUUID();
        const result = await playlistOperationQueue.enqueuePayload({
          kind: "share-import",
          label: `share-import:${playlistId}`,
          playlistId,
          url: preview.url,
          manifest: preview.manifest,
          includeFiles,
          name,
          ownerUserId: user.id,
        });
        return c.json(
          {
            queued: true,
            operationId: result.operationId,
            to: kind === "playlist" ? `/library/playlists/${playlistId}` : "/library",
          },
          202,
        );
      } catch (error) {
        return shareUnavailable(c, error, "Could not import the share. Try again.");
      }
    },
  )
  .get("/", (c) =>
    c.json(
      {
        links: listShareLinks(Number(c.var.user.id)).map(toResponse),
        tunnel: getShareTunnelState(),
      },
      200,
    ),
  )
  .get("/availability", validate("query", targetQuery), async (c) => {
    const target = targetFromInput(c.req.valid("query"), true);
    if (!target) return invalidTarget(c);
    const playlist = target.kind === "playlist";
    if (playlist && !canSharePlaylist(c.var.user, target.targetRef)) return playlistNotFound(c);
    return c.json(
      {
        trackCount: resolveShareTarget(target)?.tracks.length || 0,
        tunnelAvailable: await hasCloudflared(),
        totalTracks: playlist
          ? flowPlaylistConfig.getStaticPlaylist(target.targetRef)?.tracks.length || 0
          : null,
      },
      200,
    );
  })
  .post("/", validate("json", createInput), async (c) => {
    const input = c.req.valid("json");
    const userId = Number(c.var.user.id);
    const hosted = input.manifest !== undefined;
    const target = targetFromInput(input, hosted);
    if (!target) return invalidTarget(c);
    const payload = text(input.payload);
    if (!hosted && !PAYLOAD_PATTERN.test(payload)) {
      return c.json(
        { error: "invalid_request", message: "The share link is incomplete.", field: "payload" },
        400,
      );
    }
    if (target.kind === "playlist" && !canSharePlaylist(c.var.user, target.targetRef)) {
      return playlistNotFound(c);
    }
    const shareFiles = hosted ? input.shareFiles === true : true;
    let manifest = hosted ? resolveShareManifest(target, input.manifest) : null;
    if (hosted && (!manifest || manifest.kind !== target.kind)) {
      return c.json(
        {
          error: "invalid_manifest",
          message: "The share is incomplete or contains too many tracks.",
        },
        400,
      );
    }
    if (manifest && !shareFiles) manifest = withoutShareFiles(manifest);
    if (manifest && Buffer.byteLength(JSON.stringify(manifest)) > MAX_SHARE_BYTES - 1024) {
      return c.json(
        {
          error: "share_too_large",
          message: "This share is too large. Share a smaller selection.",
        },
        400,
      );
    }
    if (manifest && !shareFiles && target.kind !== "playlist") {
      try {
        return c.json({ link: await publishDetailsShare(manifest) }, 201);
      } catch {
        return publishFailed(c, "Could not publish the share on aurral.org. Try again.");
      }
    }
    const expiresIn = shareFiles ? text(input.expiresIn) : "never";
    if (!Object.hasOwn(EXPIRY_OPTIONS, expiresIn)) {
      return c.json(
        {
          error: "invalid_request",
          message: "Choose when the link expires.",
          field: "expiresIn",
        },
        400,
      );
    }
    const resolved = resolveShareTarget(target);
    if (shareFiles && !resolved?.tracks.length) {
      return c.json(
        { error: "not_in_library", message: "No Library tracks available to share." },
        404,
      );
    }
    if (shareFiles && !(await hasCloudflared())) {
      return c.json(
        {
          error: "tunnel_unavailable",
          message: "Install cloudflared on your server to share playback.",
        },
        503,
      );
    }
    const duration = EXPIRY_OPTIONS[expiresIn as keyof typeof EXPIRY_OPTIONS];
    const link = createShareLink({
      ...target,
      userId,
      payload,
      title: manifest?.title || resolved!.title,
      artistName: manifest?.artistName ?? resolved!.artistName,
      allowDownload: shareFiles && input.allowDownload === true,
      expiresAt: duration == null ? null : Date.now() + duration,
      manifest,
      shareFiles,
    });
    if (manifest) {
      try {
        await publishShareManifest(link.token, manifest, shareFiles);
      } catch {
        deleteShareLink(userId, String(link.id));
        return publishFailed(c, "Could not publish the share on aurral.org. Try again.");
      }
    }
    await syncShareListener();
    return c.json({ link: toResponse(link) }, 201);
  })
  .delete("/:id", async (c) => {
    const userId = Number(c.var.user.id);
    const id = c.req.param("id");
    const link = listShareLinks(userId).find((entry) => String(entry.id) === id);
    if (!link) {
      return c.json({ error: "not_found", message: "This link was already stopped." }, 404);
    }
    revokeShareFiles(userId, id);
    await syncShareListener();
    if (link.manifest) {
      const keepDetails = link.kind !== "playlist";
      try {
        await publishShareManifest(
          link.token,
          keepDetails ? withoutShareFiles(link.manifest) : null,
        );
      } catch {
        return publishFailed(
          c,
          keepDetails
            ? "Files stopped. Could not update the link on aurral.org. Try again."
            : "Files stopped. Could not remove the link from aurral.org. Try again.",
        );
      }
    }
    if (!deleteShareLink(userId, id)) {
      return c.json({ error: "not_found", message: "This link was already stopped." }, 404);
    }
    return c.body(null, 204);
  });
