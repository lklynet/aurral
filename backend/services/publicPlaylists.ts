import { createHash } from "node:crypto";
import * as v from "valibot";
import { db } from "../config/db-sqlite.ts";
import type { HubLinksRow, HubPublicationsRow } from "../db/rows.ts";
import { MAX_SHARE_BYTES, parseShareManifest, withoutShareFiles } from "../../lib/shareManifest.ts";
import { asAppError } from "../../lib/errors.ts";
import type { RequestUser } from "../middleware/requestUser.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import { resolveShareManifest } from "./shareLinks/metadata.ts";
import { SHARE_ORIGIN } from "./shareLinks/store.ts";
import { hubLinksEnabled, hubRequest, markLinkBroken, selectLink } from "./hubLink.ts";
import { logger } from "./logger.ts";

const SHELF_TTL_MS = 10 * 60 * 1000;
const SHELF_RETRY_MS = 60 * 1000;
const SHELF_TIMEOUT_MS = 3000;
const NOT_REPUBLISHABLE = new Set(["aurral-community", "aurral-share"]);

export class PublicPlaylistError extends Error {
  status: 400 | 404 | 409 | 422 | 502;
  constructor(message: string, status: PublicPlaylistError["status"]) {
    super(message);
    this.status = status;
  }
}

const createdSchema = v.object({ id: v.string() });
const refusalSchema = v.object({ error: v.string() });
const shelfSchema = v.object({
  playlists: v.array(
    v.object({
      id: v.string(),
      title: v.string(),
      handle: v.string(),
      trackCount: v.number(),
      publishedAt: v.number(),
      artist: v.nullish(v.string(), null),
    }),
  ),
});
const playlistSchema = v.object({ id: v.string(), handle: v.string(), manifest: v.unknown() });

const selectPublication = db.prepare<[string], HubPublicationsRow>(
  "SELECT * FROM hub_publications WHERE playlist_id = ?",
);
const deletePublication = db.prepare<[string]>(
  "DELETE FROM hub_publications WHERE playlist_id = ?",
);

const linkedLink = (userId: number) => {
  const link = selectLink.get(userId);
  return link?.linked_at && !link.broken ? link : null;
};

const authorized = (link: HubLinksRow, method: string, body?: unknown) => ({
  method,
  headers: { Authorization: `Bearer ${link.token}`, "Content-Type": "application/json" },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

function playlistManifest(playlistId: string) {
  const manifest = resolveShareManifest(
    { kind: "playlist", targetRef: playlistId, albumRef: null },
    null,
  );
  if (!manifest) return null;
  const details = withoutShareFiles(manifest);
  const json = JSON.stringify(details);
  if (Buffer.byteLength(json) > MAX_SHARE_BYTES - 1024) return "too_large" as const;
  return { manifest: details, hash: createHash("sha256").update(json).digest("hex") };
}

async function refusalOf(response: Response) {
  const body = v.safeParse(refusalSchema, await response.json().catch(() => null));
  return body.success ? body.output.error : null;
}

export function publicPlaylistState(userId: number) {
  const link = linkedLink(userId);
  return {
    available: hubLinksEnabled(),
    handle: link?.handle ?? null,
    playlistIds: db
      .prepare<[number], Pick<HubPublicationsRow, "playlist_id">>(
        "SELECT playlist_id FROM hub_publications WHERE user_id = ?",
      )
      .all(userId)
      .map((row) => row.playlist_id),
  };
}

export async function makePlaylistPublic(user: RequestUser, playlistId: string) {
  const playlist = flowPlaylistConfig.getStaticPlaylistForUser(user, playlistId);
  if (!playlist || playlist.ownerUserId !== user.id) {
    throw new PublicPlaylistError("Playlist not found.", 404);
  }
  if (selectPublication.get(playlistId)) return;
  if (!hubLinksEnabled()) {
    throw new PublicPlaylistError("aurral.org accounts are turned off.", 409);
  }
  const link = linkedLink(user.id);
  if (!link) throw new PublicPlaylistError("Link an aurral.org account first.", 409);
  const source = playlist.importSource;
  if (source && NOT_REPUBLISHABLE.has(source.provider)) {
    throw new PublicPlaylistError("Copies of other Aurral playlists can't be public.", 400);
  }
  const built = playlistManifest(playlistId);
  if (built === "too_large" || !built) {
    throw new PublicPlaylistError("This playlist is too large to make public.", 400);
  }
  const response = await hubRequest(
    link.origin,
    "/v1/publications",
    authorized(link, "POST", { ref: playlistId, manifest: built.manifest }),
  ).catch(() => null);
  const refusal = response && !response.ok ? await refusalOf(response) : null;
  if (refusal === "link_revoked") {
    markLinkBroken(user.id);
    throw new PublicPlaylistError("Your aurral.org link stopped working. Relink in Profile.", 409);
  }
  if (refusal === "delisted") {
    throw new PublicPlaylistError("aurral.org removed this playlist from Community.", 409);
  }
  if (response?.status === 422) {
    throw new PublicPlaylistError(
      "aurral.org doesn't allow that title. Rename the playlist and try again.",
      422,
    );
  }
  const created = response?.ok ? v.safeParse(createdSchema, await response.json()) : null;
  if (!created?.success)
    throw new PublicPlaylistError("Couldn't reach aurral.org. Try again.", 502);
  db.prepare<[string, number, string, string, number]>(
    "INSERT INTO hub_publications (playlist_id, user_id, publication_id, manifest_hash, published_at) VALUES (?, ?, ?, ?, ?)",
  ).run(playlistId, user.id, created.output.id, built.hash, Date.now());
  shelfCache = null;
}

async function unpublish(publication: HubPublicationsRow) {
  const link = selectLink.get(publication.user_id);
  if (link) {
    const response = await hubRequest(
      link.origin,
      `/v1/publications/${encodeURIComponent(publication.publication_id)}`,
      authorized(link, "DELETE"),
    ).catch(() => null);
    if (!response || (!response.ok && response.status !== 401)) return false;
  }
  deletePublication.run(publication.playlist_id);
  shelfCache = null;
  return true;
}

export async function makePlaylistPrivate(user: RequestUser, playlistId: string) {
  const publication = selectPublication.get(playlistId);
  if (!publication || publication.user_id !== user.id) return;
  if (!(await unpublish(publication))) {
    throw new PublicPlaylistError("Couldn't reach aurral.org. Try again.", 502);
  }
}

export async function unpublishDeletedPlaylist(playlistId: string) {
  const publication = selectPublication.get(playlistId);
  if (publication) await unpublish(publication);
}

export async function refreshPublicPlaylists() {
  const rows = db.prepare<[], HubPublicationsRow>("SELECT * FROM hub_publications").all();
  let updated = 0;
  for (const publication of rows) {
    const link = linkedLink(publication.user_id);
    if (!link) continue;
    if (!flowPlaylistConfig.getStaticPlaylist(publication.playlist_id)) {
      await unpublish(publication);
      continue;
    }
    const built = playlistManifest(publication.playlist_id);
    if (!built || built === "too_large" || built.hash === publication.manifest_hash) continue;
    const response = await hubRequest(
      link.origin,
      `/v1/publications/${encodeURIComponent(publication.publication_id)}`,
      authorized(link, "PUT", { manifest: built.manifest }),
    ).catch((error: unknown) => {
      logger.info("public-playlists", "aurral.org didn't answer a playlist update", {
        message: asAppError(error)?.message,
      });
      return null;
    });
    if (!response) continue;
    const refusal = response.ok ? null : await refusalOf(response);
    if (refusal === "link_revoked") markLinkBroken(publication.user_id);
    else if (response.status === 404) deletePublication.run(publication.playlist_id);
    else if (response.ok) {
      db.prepare<[string, string]>(
        "UPDATE hub_publications SET manifest_hash = ? WHERE playlist_id = ?",
      ).run(built.hash, publication.playlist_id);
      updated += 1;
    } else {
      logger.info("public-playlists", "aurral.org kept the last version of a public playlist", {
        status: response.status,
        refusal,
      });
    }
  }
  return { checked: rows.length, updated };
}

type Shelf = v.InferOutput<typeof shelfSchema>["playlists"];
let shelfCache: { playlists: Shelf; expiresAt: number } | null = null;
let shelfRequest: Promise<Shelf> | null = null;

async function fetchShelf() {
  const response = await fetch(`${SHARE_ORIGIN}/v1/playlists`, {
    signal: AbortSignal.timeout(SHELF_TIMEOUT_MS),
  }).catch(() => null);
  const body = response?.ok
    ? v.safeParse(shelfSchema, await response.json().catch(() => null))
    : null;
  const playlists = body?.success ? body.output.playlists : [];
  shelfCache = {
    playlists,
    expiresAt: Date.now() + (body?.success ? SHELF_TTL_MS : SHELF_RETRY_MS),
  };
  return playlists;
}

export async function communityShelf() {
  if (shelfCache && shelfCache.expiresAt > Date.now()) return shelfCache.playlists;
  shelfRequest ??= fetchShelf().finally(() => {
    shelfRequest = null;
  });
  return shelfRequest;
}

export const resetCommunityShelf = () => {
  shelfCache = null;
};

const notPublic = () =>
  Object.assign(new Error("No longer public. Your copy stays and stops syncing."), {
    statusCode: 404,
    code: "PLAYLIST_SOURCE_GONE",
  });

export async function communityPlaylist(id: string) {
  const response = await fetch(`${SHARE_ORIGIN}/v1/playlists/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404 && (await refusalOf(response)) === "not_public") throw notPublic();
  const body = response.ok ? v.safeParse(playlistSchema, await response.json()) : null;
  const manifest = body?.success ? parseShareManifest(body.output.manifest) : null;
  if (!body?.success || manifest?.kind !== "playlist") {
    throw Object.assign(new Error("Couldn't load this playlist from aurral.org."), {
      statusCode: 502,
    });
  }
  return { id, handle: body.output.handle, manifest };
}
