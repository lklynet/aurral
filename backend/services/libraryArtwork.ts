import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFile, selectCover } from "music-metadata";
import { db } from "../config/db-sqlite.ts";
import { asAppError } from "../../lib/errors.ts";
import { resolveAurralDataDir } from "../config/data-dir.ts";
import createCache from "./apiClients/simpleCache.ts";
import type {
  ArtistOverridesRow,
  LibraryAlbumsRow,
  LibraryArtistsRow,
  LibraryMediaFilesRow,
  SettingsRow,
} from "../db/rows.ts";
import {
  MAX_SOURCE_IMAGE_BYTES,
  fetchOptimizedImage,
  inspectImageBuffer,
  optimizeImageBuffer,
} from "./imageProxyService.ts";
import { getArtistImage } from "./imageService.ts";
import { getCustomArtwork } from "./customArtworkService.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import getSharp from "./sharpConfig.ts";
import { readLibraryMetadata } from "./libraryMetadata.ts";
import { fetchReleaseGroupCoverUrl } from "./releaseGroupCoverService.ts";

export type LibraryArtworkKind = "album" | "artist";
type Artwork = { buffer: Uint8Array; contentType: string };
type ArtworkLookup = { artwork: Artwork | null; transient?: boolean; fromFiles?: boolean };
type StoredArtwork = { filePath: string; contentType: string };

const ARTWORK_DIR = path.join(resolveAurralDataDir(), "library-artwork");
const MISSING_TTL_SECONDS = 24 * 60 * 60;
const TRANSIENT_TTL_SECONDS = 5 * 60;
const ARTIST_FALLBACK_ALBUMS = 5;
const SIDECAR_NAMES = ["cover", "folder", "front", "album"];
const COVER_MARKER = "aurral:album-cover";
// Navidrome and Aurral both ignore this name, so a kept cover stays hidden.
const ORIGINAL_COVER = "cover-original";
const SIDECAR_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const STORED_EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/gif": "gif",
  "image/apng": "png",
};
const STORED_CONTENT_TYPES = Object.fromEntries(
  Object.entries(STORED_EXTENSIONS).map(([contentType, extension]) => [extension, contentType]),
);
const missingArtwork = createCache(MISSING_TTL_SECONDS, 10_000);
const lookups = new Map<string, Promise<StoredArtwork | null>>();

const albumVersionsStmt = db.prepare<
  [string],
  Pick<LibraryAlbumsRow, "id" | "mbid" | "release_group_mbid"> & {
    files: number;
    bytes: number;
    modified: number;
  }
>(`SELECT album.id, album.mbid, album.release_group_mbid,
    COUNT(media.id) AS files,
    COALESCE(SUM(media.size), 0) AS bytes,
    COALESCE(MAX(media.mtime_ms), 0) AS modified
  FROM library_albums AS album
  LEFT JOIN library_media_files AS media ON media.album_id = album.id AND media.available = 1
  WHERE album.id IN (SELECT value FROM json_each(?))
  GROUP BY album.id`);
const ARTIST_ALBUM_ORDER = "ORDER BY release_date IS NULL, release_date DESC, id DESC";
const artistVersionsStmt = db.prepare<
  [string],
  Pick<LibraryArtistsRow, "id" | "mbid"> & {
    overridden_at: ArtistOverridesRow["updated_at"];
    lead_album_id: LibraryAlbumsRow["id"] | null;
  }
>(`SELECT artist.id, artist.mbid, artist_override.updated_at AS overridden_at,
    (SELECT id FROM library_albums WHERE artist_id = artist.id ${ARTIST_ALBUM_ORDER} LIMIT 1)
      AS lead_album_id
  FROM library_artists AS artist
  LEFT JOIN artist_overrides AS artist_override ON artist_override.mbid = artist.mbid
  WHERE artist.id IN (SELECT value FROM json_each(?))`);
const albumStmt = db.prepare<
  [number],
  Pick<LibraryAlbumsRow, "mbid" | "release_group_mbid" | "title" | "metadata_json"> & {
    artist_name: string;
    artist_mbid: string | null;
  }
>(`SELECT album.mbid, album.release_group_mbid, album.title, album.metadata_json,
    artist.name AS artist_name, artist.mbid AS artist_mbid
  FROM library_albums AS album
  JOIN library_artists AS artist ON artist.id = album.artist_id
  WHERE album.id = ?`);
const albumFilesStmt = db.prepare<[number], Pick<LibraryMediaFilesRow, "path">>(
  `SELECT path FROM library_media_files
  WHERE album_id = ? AND available = 1 ORDER BY path COLLATE NOCASE LIMIT 100`,
);
const aurralFilesStmt = db.prepare<[number], Pick<LibraryMediaFilesRow, "path">>(
  "SELECT path FROM library_media_files WHERE album_id = ? AND available = 1 AND source = 'aurral'",
);
const changedAlbumsStmt = db.prepare<
  [string],
  { album_id: NonNullable<LibraryMediaFilesRow["album_id"]> }
>(
  `SELECT DISTINCT album_id FROM library_media_files
  WHERE source = 'aurral' AND available = 1 AND album_id IS NOT NULL
    AND path IN (SELECT value FROM json_each(?))`,
);
const artistStmt = db.prepare<[number], Pick<LibraryArtistsRow, "mbid" | "name">>(
  "SELECT mbid, name FROM library_artists WHERE id = ?",
);
const artistAlbumsStmt = db.prepare<[number, number], Pick<LibraryAlbumsRow, "id">>(
  `SELECT id FROM library_albums WHERE artist_id = ? ${ARTIST_ALBUM_ORDER} LIMIT ?`,
);
const revisionStmt = db.prepare<[], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = 'libraryArtworkRevision'",
);
const setRevisionStmt = db.prepare<[string]>(
  "INSERT OR REPLACE INTO settings (key, value) VALUES ('libraryArtworkRevision', ?)",
);
const latestScanStmt = db.prepare<[], { completedAt: number | null }>(
  "SELECT MAX(completed_at) AS completedAt FROM library_scan_runs",
);

const versionOf = (...parts: unknown[]) =>
  crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);

const libraryIds = (ids: readonly (string | number)[]) =>
  JSON.stringify([...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]);

const albumVersions = (json: string, revision: string) =>
  new Map(
    albumVersionsStmt
      .all(json)
      .map((row) => [
        String(row.id),
        versionOf(
          revision,
          row.files,
          row.bytes,
          row.modified,
          row.release_group_mbid ?? row.mbid ?? "",
        ),
      ]),
  );

export function getLibraryArtworkVersions(
  kind: LibraryArtworkKind,
  ids: readonly (string | number)[],
) {
  const json = libraryIds(ids);
  if (json === "[]") return new Map<string, string>();
  const revision = revisionStmt.get()?.value ?? "";
  if (kind === "album") return albumVersions(json, revision);
  const artists = artistVersionsStmt.all(json);
  const leadAlbums = albumVersions(
    JSON.stringify(artists.flatMap((row) => row.lead_album_id ?? [])),
    revision,
  );
  return new Map(
    artists.map((row) => [
      String(row.id),
      versionOf(
        revision,
        row.mbid ?? "",
        row.overridden_at ?? "",
        row.lead_album_id ?? "",
        leadAlbums.get(String(row.lead_album_id)) ?? "",
      ),
    ]),
  );
}

export const buildLibraryArtworkUrl = (
  kind: LibraryArtworkKind,
  id: string | number,
  version: string | undefined,
) =>
  `/api/library/${kind}s/${encodeURIComponent(String(id))}/cover${version ? `?v=${version}` : ""}`;

async function renderCover(buffer: Uint8Array | undefined, contentType: string) {
  if (!buffer?.length || buffer.length > MAX_SOURCE_IMAGE_BYTES) return null;
  try {
    await inspectImageBuffer(buffer, contentType);
    return await optimizeImageBuffer(buffer, contentType);
  } catch {
    return null;
  }
}

function sidecarRank(name: string) {
  const extension = path.extname(name).toLowerCase();
  if (!SIDECAR_CONTENT_TYPES[extension]) return -1;
  return SIDECAR_NAMES.indexOf(path.basename(name, path.extname(name)).toLowerCase());
}

async function readSidecarCover(folder: string) {
  let realFolder: string;
  let names: string[];
  try {
    realFolder = await fs.realpath(folder);
    names = await fs.readdir(folder);
  } catch {
    return null;
  }
  const candidates = names
    .map((name) => ({ name, rank: sidecarRank(name) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));
  for (const { name } of candidates) {
    try {
      const artworkPath = await fs.realpath(path.join(folder, name));
      if (path.dirname(artworkPath) !== realFolder) continue;
      const stat = await fs.stat(artworkPath);
      if (!stat.isFile() || stat.size > MAX_SOURCE_IMAGE_BYTES) continue;
      const contentType = SIDECAR_CONTENT_TYPES[path.extname(name).toLowerCase()];
      if (!contentType) continue;
      const cover = await renderCover(await fs.readFile(artworkPath), contentType);
      if (cover) return cover;
    } catch {
      continue;
    }
  }
  return null;
}

async function readEmbeddedCover(filePath: string) {
  try {
    const metadata = await parseFile(filePath, { duration: false });
    const picture = selectCover(metadata.common.picture);
    const contentType = String(picture?.format || "")
      .toLowerCase()
      .replace(/^image\/jpg$/, "image/jpeg");
    return await renderCover(picture?.data, contentType);
  } catch {
    return null;
  }
}

async function readFileArtwork(albumId: number) {
  const checkedFolders = new Set<string>();
  for (const file of albumFilesStmt.all(albumId)) {
    const embedded = await readEmbeddedCover(file.path);
    if (embedded) return embedded;
    const folder = path.dirname(file.path);
    if (checkedFolders.has(folder)) continue;
    checkedFolders.add(folder);
    const sidecar = await readSidecarCover(folder);
    if (sidecar) return sidecar;
  }
  return null;
}

async function downloadArtwork(url: string): Promise<ArtworkLookup> {
  try {
    return { artwork: await fetchOptimizedImage(url) };
  } catch {
    return { artwork: null, transient: true };
  }
}

function metadataImageUrl(metadataJson: string | null) {
  const metadata = readLibraryMetadata(metadataJson);
  return (
    (metadata?.images ?? [])
      .map((image) => image?.remoteUrl || image?.imageUrl || image?.url)
      .find((url) => /^https?:\/\//i.test(url || "")) || null
  );
}

async function findArtistPhoto(mbid: string, artistName: string): Promise<ArtworkLookup> {
  const image = await getArtistImage(mbid, { artistName });
  const photo = image.url ? await downloadArtwork(image.url) : null;
  if (photo?.artwork) return photo;
  return { artwork: null, transient: Boolean(photo?.transient || image.transientError) };
}

async function findAlbumCover(albumId: number): Promise<ArtworkLookup> {
  const fileArtwork = await readFileArtwork(albumId);
  if (fileArtwork) return { artwork: fileArtwork, fromFiles: true };
  const album = albumStmt.get(albumId);
  if (!album) return { artwork: null };
  const metadataUrl = metadataImageUrl(album.metadata_json);
  const fromMetadata = metadataUrl ? await downloadArtwork(metadataUrl) : null;
  if (fromMetadata?.artwork) return fromMetadata;
  const releaseGroupMbid = album.release_group_mbid || album.mbid;
  if (!releaseGroupMbid) return { artwork: null, transient: fromMetadata?.transient };
  const cover = await fetchReleaseGroupCoverUrl(releaseGroupMbid, {
    artistName: album.artist_name,
    albumTitle: album.title,
  });
  if (cover?.imageUrl) return downloadArtwork(cover.imageUrl);
  return { artwork: null, transient: Boolean(fromMetadata?.transient || cover?.transientError) };
}

async function findAlbumArtwork(albumId: number): Promise<ArtworkLookup> {
  const cover = await findAlbumCover(albumId);
  if (cover.artwork || albumFilesStmt.get(albumId)) return cover;
  const album = albumStmt.get(albumId);
  if (!album?.artist_mbid) return cover;
  const photo = await findArtistPhoto(album.artist_mbid, album.artist_name);
  return photo.artwork ? photo : { artwork: null, transient: cover.transient || photo.transient };
}

async function findArtistArtwork(artistId: number): Promise<ArtworkLookup> {
  const artist = artistStmt.get(artistId);
  if (!artist) return { artwork: null };
  if (artist.mbid) {
    const photo = await findArtistPhoto(artist.mbid, artist.name);
    if (photo.artwork || photo.transient) return photo;
  }
  for (const album of artistAlbumsStmt.all(artistId, ARTIST_FALLBACK_ALBUMS)) {
    const stored = await getLibraryArtwork("album", String(album.id));
    if (stored) {
      return {
        artwork: { buffer: await fs.readFile(stored.filePath), contentType: stored.contentType },
      };
    }
  }
  return { artwork: null };
}

const itemFolder = (kind: LibraryArtworkKind, id: number) =>
  path.join(ARTWORK_DIR, `${kind}-${id}`);

async function readStoredArtwork(folder: string, version: string) {
  const names = await fs.readdir(folder).catch(() => []);
  const name = names.find((entry) => entry.startsWith(`${version}.`) && !entry.endsWith(".tmp"));
  const contentType = name && STORED_CONTENT_TYPES[path.extname(name).slice(1)];
  return name && contentType ? { filePath: path.join(folder, name), contentType } : null;
}

async function storeArtwork(
  kind: LibraryArtworkKind,
  id: number,
  version: string,
  artwork: Artwork,
) {
  const extension = STORED_EXTENSIONS[artwork.contentType];
  if (!extension) return null;
  const folder = itemFolder(kind, id);
  await fs.mkdir(folder, { recursive: true });
  const name = `${version}.${extension}`;
  const filePath = path.join(folder, name);
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, artwork.buffer);
  await fs.rename(temporary, filePath);
  const current = getLibraryArtworkVersions(kind, [id]).get(String(id));
  for (const entry of await fs.readdir(folder)) {
    if (entry === name || entry.endsWith(".tmp") || entry.startsWith(`${current}.`)) continue;
    await fs.rm(path.join(folder, entry), { force: true });
  }
  return { filePath, contentType: artwork.contentType };
}

async function loadArtwork(kind: LibraryArtworkKind, id: number, version: string, key: string) {
  const folder = itemFolder(kind, id);
  const stored = await readStoredArtwork(folder, version);
  if (stored) return stored;
  const scannedAt = latestScanStmt.get()?.completedAt ?? 0;
  if (missingArtwork.get(key) === scannedAt) return null;
  const { artwork, transient, fromFiles } =
    kind === "album" ? await findAlbumArtwork(id) : await findArtistArtwork(id);
  const created = artwork ? await storeArtwork(kind, id, version, artwork) : null;
  if (!artwork || !created) {
    missingArtwork.set(key, scannedAt, transient ? TRANSIENT_TTL_SECONDS : MISSING_TTL_SECONDS);
    return null;
  }
  if (kind === "album" && !fromFiles) await writeFolderCovers(id, artwork);
  return created;
}

const albumFolders = (albumId: number) =>
  new Set(aurralFilesStmt.all(albumId).map((file) => path.dirname(file.path)));

const encodeCover = async (buffer: Uint8Array) =>
  (await getSharp())(buffer)
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { ImageDescription: COVER_MARKER } })
    .toBuffer();

async function isAurralCover(filePath: string) {
  try {
    const { exif } = await (await getSharp())(filePath).metadata();
    return Boolean(exif?.includes(COVER_MARKER));
  } catch {
    return false;
  }
}

async function moveWithoutReplacing(from: string, to: string) {
  try {
    await fs.copyFile(from, to, constants.COPYFILE_EXCL);
  } catch (error) {
    if (asAppError(error)?.code === "EEXIST") return;
    throw error;
  }
  await fs.rm(from, { force: true });
}

async function writeNewFile(filePath: string, contents: Buffer) {
  await fs.writeFile(filePath, contents, { flag: "wx" }).catch((error) => {
    if (asAppError(error)?.code !== "EEXIST") throw error;
  });
}

async function warnOnFailure(albumId: number, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    logger.warn("library", "Could not update album art in the album folder", {
      albumId,
      reason: safeLogDiagnostic(error),
    });
  }
}

const writeFolderCovers = (albumId: number, artwork: Artwork) =>
  warnOnFailure(albumId, async () => {
    if (getCustomArtwork("album", albumId)) return;
    let cover: Buffer | undefined;
    for (const folder of albumFolders(albumId)) {
      const names = await fs.readdir(folder).catch(() => null);
      if (!names || names.some((name) => sidecarRank(name) >= 0)) continue;
      cover ??= await encodeCover(artwork.buffer);
      await writeNewFile(path.join(folder, "cover.jpg"), cover);
    }
  });

async function placeCustomCover(folder: string, cover: Buffer) {
  const target = path.join(folder, "cover.jpg");
  const current = await fs.readFile(target).catch(() => null);
  if (current?.equals(cover)) return;
  for (const name of await fs.readdir(folder)) {
    if (sidecarRank(name) !== 0) continue;
    const filePath = path.join(folder, name);
    if (await isAurralCover(filePath)) await fs.rm(filePath, { force: true });
    else {
      const original = path.join(folder, `${ORIGINAL_COVER}${path.extname(name)}`);
      await moveWithoutReplacing(filePath, original);
    }
  }
  await writeNewFile(target, cover);
}

async function restoreFolderCover(folder: string) {
  const names = await fs.readdir(folder).catch(() => null);
  if (!names) return;
  for (const name of names) {
    const filePath = path.join(folder, name);
    if (sidecarRank(name) === 0 && (await isAurralCover(filePath))) {
      await fs.rm(filePath, { force: true });
    }
  }
  for (const name of names) {
    const extension = path.extname(name);
    if (path.basename(name, extension).toLowerCase() !== ORIGINAL_COVER) continue;
    if (!SIDECAR_CONTENT_TYPES[extension.toLowerCase()]) continue;
    await moveWithoutReplacing(path.join(folder, name), path.join(folder, `cover${extension}`));
  }
}

const folderSyncs = new Map<number, Promise<void>>();

export function syncAlbumFolderCovers(albumId: number) {
  const sync = (folderSyncs.get(albumId) ?? Promise.resolve()).then(() =>
    syncFolderCovers(albumId),
  );
  folderSyncs.set(albumId, sync);
  return sync.finally(() => {
    if (folderSyncs.get(albumId) === sync) folderSyncs.delete(albumId);
  });
}

const syncFolderCovers = (albumId: number) =>
  warnOnFailure(albumId, async () => {
    const custom = getCustomArtwork("album", albumId);
    if (custom) {
      const cover = await encodeCover(await fs.readFile(custom.filePath));
      for (const folder of albumFolders(albumId)) await placeCustomCover(folder, cover);
      return;
    }
    for (const folder of albumFolders(albumId)) await restoreFolderCover(folder);
    await fs.rm(itemFolder("album", albumId), { recursive: true, force: true });
    const version = getLibraryArtworkVersions("album", [albumId]).get(String(albumId));
    missingArtwork.delete(`album:${albumId}:${version}`);
    await getLibraryArtwork("album", String(albumId));
  });

export async function resolveChangedAlbumCovers(filePaths: Iterable<string>) {
  for (const { album_id } of changedAlbumsStmt.all(JSON.stringify([...filePaths]))) {
    if (getCustomArtwork("album", album_id)) await syncAlbumFolderCovers(album_id);
    else await getLibraryArtwork("album", String(album_id)).catch(() => null);
  }
}

export function getLibraryArtwork(kind: LibraryArtworkKind, id: string) {
  if (!/^[1-9]\d*$/.test(id)) return Promise.resolve(null);
  const version = getLibraryArtworkVersions(kind, [id]).get(id);
  if (!version) return Promise.resolve(null);
  const key = `${kind}:${id}:${version}`;
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = loadArtwork(kind, Number(id), version, key).finally(() => lookups.delete(key));
    lookups.set(key, lookup);
  }
  return lookup;
}

export async function pruneLibraryArtwork() {
  const names = await fs.readdir(ARTWORK_DIR).catch(() => []);
  if (!names.length) return;
  const kept = new Set([
    ...db
      .prepare<[], Pick<LibraryAlbumsRow, "id">>("SELECT id FROM library_albums")
      .all()
      .map((row) => `album-${row.id}`),
    ...db
      .prepare<[], Pick<LibraryArtistsRow, "id">>("SELECT id FROM library_artists")
      .all()
      .map((row) => `artist-${row.id}`),
  ]);
  for (const name of names) {
    if (!kept.has(name)) {
      await fs.rm(path.join(ARTWORK_DIR, name), { recursive: true, force: true });
    }
  }
}

export async function clearLibraryArtwork() {
  await fs.rm(ARTWORK_DIR, { recursive: true, force: true });
  setRevisionStmt.run(String(Date.now()));
  missingArtwork.flushAll();
}
