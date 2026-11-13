import fs from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import createCache from "./apiClients/simpleCache.ts";
import {
  DownloadSourceError,
  type AlbumQuery,
  type DownloadSource,
  type ResolvedTrack,
  type Upgrade,
} from "./download/downloadSource.ts";
import { getDownloadClient } from "./download/downloadClientSettings.ts";
import {
  buildDeemixAlbumSearchQueries,
  buildDeemixSearchQueries,
  isSameCoreAlbum,
} from "./downloadJobs/deemixSearch.ts";
import { isInLibraryFolder } from "./downloadJobs/reviewFiles.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";
import { mergeSearchResults } from "./pipelineHelpers.ts";
import { isQualityUpgrade } from "./qualityProfileModel.ts";
import { getQualityProfile } from "./qualityProfile.ts";
import type { ReleaseManifest } from "./releaseManifest.ts";
import { hasUsableSearchCandidates } from "./trackMatching/index.ts";
import { judgeRelease } from "./trackMatching/releaseJudge.ts";

const SEARCH_LIMIT = 10;
const MANUAL_RESULTS = 50;
const MAX_ALBUMS = 3;
const FINISHED = new Set(["completed", "withErrors", "failed"]);
const ALBUM = "album:";

const deemix = () => getDownloadClient("deemix");

type DeemixTrack = Awaited<ReturnType<ReturnType<typeof deemix>["search"]>>[number];
type DeemixAlbum = Awaited<ReturnType<ReturnType<typeof deemix>["getAlbum"]>>;
type DeemixAlbumTrack = DeemixAlbum["tracks"][number];
type QueueItem = Awaited<ReturnType<ReturnType<typeof deemix>["getQueue"]>>[string];

const queuedTrack = v.object({ id: v.string(), url: v.string() });

const toResult = (track: DeemixTrack) => ({
  ...track,
  durationMs: track.durationSec > 0 ? track.durationSec * 1000 : null,
});

// The configured bitrate fixes the tier, so an upgrade that deemix cannot
// improve on is refused before anything downloads.
function refuseUnusableUpgrade(upgrade: Upgrade) {
  if (!upgrade) return;
  const tier = deemix().getQualityTierId();
  if (isQualityUpgrade({ tier }, upgrade.currentTier, getQualityProfile())) return;
  throw new DownloadSourceError(
    `deemix downloads ${tier || "an unknown tier"}, which is not an upgrade over ${
      upgrade.currentTier || "the current file"
    }`,
  );
}

async function searchTracks(track: ResolvedTrack, denied: ReadonlySet<string>) {
  const found: DeemixTrack[] = [];
  const seen = new Set<string>();
  const readable = () => found.filter((result) => result.readable);
  let lastError = "";
  for (const query of buildDeemixSearchQueries(track)) {
    if (hasUsableSearchCandidates({ source: "deemix", results: readable(), request: track })) break;
    try {
      const results = await deemix().search(query, { limit: SEARCH_LIMIT });
      mergeSearchResults(
        found,
        seen,
        results.filter(
          (result) => !denied.has(result.id) && !denied.has(`${ALBUM}${result.albumId}`),
        ),
        (result) => result.id,
      );
    } catch (error) {
      lastError = safeLogDiagnostic(error);
      logger.warn("deemix", "deemix search failed", { query, error: lastError });
    }
  }
  if (lastError && found.length === 0) throw new DownloadSourceError(lastError);
  return readable().map(toResult);
}

const albums = createCache<DeemixAlbum>(10 * 60, 50);

async function deezerAlbum(albumId: string) {
  const cached = albums.get(albumId);
  if (cached) return cached;
  const album = await deemix().getAlbum(albumId);
  albums.set(albumId, album);
  return album;
}

const listing = (artist: string, title: string, tracks: DeemixAlbumTrack[]) => ({
  artistLabel: artist || null,
  albumLabel: title,
  files: tracks.map((track) => ({
    title: track.title,
    artists: [track.artist].filter(Boolean),
    durationMs: track.durationSec > 0 ? track.durationSec * 1000 : null,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
  })),
});

// An album counts only when its whole Deezer tracklist is the requested
// release and Deezer streams some of it, so nothing downloads before that
// check.
async function searchAlbums(
  album: AlbumQuery,
  release: ReleaseManifest | null,
  denied: ReadonlySet<string>,
) {
  if (!release) return [];
  const albumName = release.title || album.title;
  const checked = new Set<string>();
  const exact: { id: string; title: string; artist: string; tracks: number; fit: number }[] = [];
  let lastError = "";
  const queries = buildDeemixAlbumSearchQueries({
    artistName: album.artist,
    albumName,
    compilation: release.compilation,
  });
  for (const query of queries) {
    const found = await deemix()
      .searchAlbums(query, { limit: SEARCH_LIMIT })
      .catch((error: unknown) => {
        lastError = safeLogDiagnostic(error);
        logger.warn("deemix", "Album search failed", { query, error: lastError });
        return [];
      });
    const fresh = found.filter(
      (entry) =>
        !checked.has(entry.id) && !denied.has(entry.id) && isSameCoreAlbum(entry.title, albumName),
    );
    for (const entry of fresh.slice(0, MAX_ALBUMS)) {
      checked.add(entry.id);
      const tracks = await deezerAlbum(entry.id).then(
        (album) => album.tracks,
        (error: unknown) => {
          lastError = safeLogDiagnostic(error);
          logger.warn("deemix", "Album tracklist failed", { albumId: entry.id, error: lastError });
          return null;
        },
      );
      const verdict = tracks && judgeRelease(release, listing(entry.artist, entry.title, tracks));
      if (tracks?.some((track) => track.readable) && verdict?.kind === "exact")
        exact.push({ ...entry, tracks: tracks.length, fit: verdict.fit });
    }
    if (exact.length > 0) break;
  }
  if (exact.length === 0 && lastError) throw new DownloadSourceError(lastError);
  return exact
    .sort((left, right) => right.fit - left.fit)
    .map((found) => ({
      id: found.id,
      title: found.title,
      artist: found.artist || album.artist || found.title,
      trackCount: found.tracks,
    }));
}

const extension = () => (deemix().getQualityTierId()?.startsWith("flac") ? "flac" : "mp3");

const safeName = (name: string) => name.replace(/[\\/]/g, " ");

// Deezer's tracklist as the files of the album, named like a ripped album, so
// Aurral keeps the wanted ones by their names. A track Deezer can't stream
// isn't listed.
async function albumFiles(albumId: string) {
  const album = await deezerAlbum(albumId);
  const tracks = album.tracks.filter((track) => track.readable);
  const discs = new Set(tracks.map((track) => track.discNumber ?? 1));
  const folder = safeName([album.artist, album.title].filter(Boolean).join(" - "));
  const name = (track: DeemixAlbumTrack) =>
    `${String(track.trackNumber ?? 0).padStart(2, "0")} - ${safeName(track.title)}.${extension()}`;
  return tracks.map((track) => ({
    track,
    path: [folder, discs.size > 1 && `Disc ${track.discNumber ?? 1}`, name(track)]
      .filter(Boolean)
      .join("/"),
  }));
}

const albumId = (pending: string) =>
  pending.startsWith(ALBUM) ? pending.slice(ALBUM.length) : null;

async function queueIds(pending: string) {
  const album = albumId(pending);
  if (!album) return [pending];
  const { tracks } = await deezerAlbum(album);
  return [
    deemix().queueId("album", album),
    ...tracks.map((track) => deemix().queueId("track", track.id)),
  ];
}

function queueError(items: QueueItem[]) {
  for (const error of items.flatMap((item) => item.errors ?? [])) {
    const detail =
      typeof error === "object" && error !== null ? error.error || error.message : error;
    const message = String(detail || "").trim();
    if (message) return message;
  }
  return "";
}

function commonFolder(files: string[]) {
  const [first = [], ...rest] = files.map((file) => path.dirname(file).split(path.sep));
  let length = 0;
  while (length < first.length && rest.every((parts) => parts[length] === first[length]))
    length += 1;
  return first.slice(0, length).join(path.sep) || path.sep;
}

// deemix doesn't keep a finished file, so Aurral moves it into the folder it
// gave the download, and copies one that sits in a Library folder.
async function handOver(files: string[], directory: string) {
  const root = commonFolder(files);
  const names: string[] = [];
  for (const file of files) {
    if (!(await fs.stat(file).catch(() => null))?.isFile())
      throw new DownloadSourceError(
        `deemix download is not readable at ${file}. Add a path mapping for deemix in Settings.`,
      );
    const name = path.relative(root, file);
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (isInLibraryFolder(file)) await fs.copyFile(file, target);
    else
      await fs.rename(file, target).catch(async () => {
        await fs.copyFile(file, target);
        await fs.rm(file, { force: true });
      });
    names.push(name);
  }
  return names;
}

export const deemixSource = {
  id: "deemix",
  staging: "deemix",
  tracks: {
    search(track, { upgrade, denied }) {
      refuseUnusableUpgrade(upgrade);
      return searchTracks(track, denied);
    },
    async manualSearch(track) {
      const query = [track.artistName, track.trackName, track.albumName].filter(Boolean).join(" ");
      const found = await deemix().search(query, { limit: MANUAL_RESULTS });
      return found.filter((result) => result.readable).map(toResult);
    },
    async download({ result }) {
      const parsed = v.safeParse(queuedTrack, result);
      if (!parsed.success) throw new DownloadSourceError("No deemix track URL available");
      try {
        return { pending: await deemix().addToQueue(parsed.output.url, parsed.output.id) };
      } catch (error) {
        throw new DownloadSourceError(safeLogDiagnostic(error));
      }
    },
  },
  albums: {
    search(album, { upgrade, denied, release }) {
      refuseUnusableUpgrade(upgrade);
      return searchAlbums(album, release, denied);
    },
    async download({ result }) {
      return { pending: `${ALBUM}${result.id}` };
    },
    // Nothing is queued until Aurral names the tracks it wants, and a whole
    // album queues as one item.
    files: {
      async list(pending) {
        const album = albumId(pending);
        return album
          ? (await albumFiles(album)).map((file) => ({ path: file.path, size: 0 }))
          : null;
      },
      async keep({ id, paths }) {
        const album = albumId(id);
        if (!album) return;
        const { tracks } = await deezerAlbum(album);
        const kept = (await albumFiles(album)).filter((file) => paths.includes(file.path));
        try {
          if (kept.length === tracks.length)
            await deemix().addAlbumToQueue(`https://www.deezer.com/album/${album}`, album);
          else for (const { track } of kept) await deemix().addToQueue(track.url, track.id);
        } catch (error) {
          throw new DownloadSourceError(safeLogDiagnostic(error));
        }
      },
    },
  },
  async status({ id, directory }) {
    const queue = await deemix().getQueue();
    const queued = (await queueIds(id)).flatMap((uuid) => {
      const item = queue[uuid];
      return item ? [{ uuid, item }] : [];
    });
    if (queued.length === 0)
      throw new DownloadSourceError("deemix no longer lists this download in its queue");
    if (queued.some(({ item }) => !FINISHED.has(String(item.status || "")))) return { done: false };
    const mappings = getPathMappings("deemix");
    const files = [
      ...new Set(
        queued.flatMap(({ item }) =>
          (item.files ?? []).flatMap((file) => {
            const remote = String(file?.path || "").trim();
            return remote ? [resolveLocalPath(remote, mappings)] : [];
          }),
        ),
      ),
    ];
    const items = queued.map(({ item }) => item);
    if (files.length === 0)
      throw new DownloadSourceError(queueError(items) || "deemix download failed");
    const [name] = await handOver(files, directory);
    // deemix names a queue item by its track and bitrate, so a finished one
    // left behind would answer the next request for the track.
    for (const { uuid } of queued)
      await deemix()
        .removeFromQueue(uuid)
        .catch((error: unknown) =>
          logger.warn("deemix", "Could not remove a finished download", {
            uuid,
            reason: safeLogDiagnostic(error),
          }),
        );
    return albumId(id) ? { done: true } : { done: true, path: name };
  },
  async discard(id) {
    if (!deemix().isConfigured()) throw new Error("deemix is not configured");
    const queue = await deemix().getQueue();
    for (const uuid of await queueIds(id)) if (queue[uuid]) await deemix().removeFromQueue(uuid);
  },
} satisfies DownloadSource;

const legacyStep = v.looseObject({
  phase: v.string(),
  queueUuid: v.nullish(v.string()),
  queueUuids: v.nullish(v.array(v.nullish(v.string()))),
  candidates: v.nullish(v.array(v.looseObject({ kind: v.optional(v.string()) }))),
});

// A step queued before deemix used the download source contract searches
// again, and what it queued leaves deemix.
export async function removeLegacyDeemixDownload(payload: unknown) {
  const step = v.safeParse(legacyStep, payload);
  if (!step.success || step.output.phase === "search") return false;
  const { queueUuid, queueUuids, candidates } = step.output;
  const ids = [queueUuid, ...(queueUuids ?? [])].filter((uuid) => typeof uuid === "string");
  if (ids.length === 0 && !candidates?.some((candidate) => candidate.kind)) return false;
  for (const uuid of ids)
    await deemix()
      .removeFromQueue(uuid)
      .catch((error: unknown) =>
        logger.warn("deemix", "Could not remove a download started before an update", {
          uuid,
          reason: safeLogDiagnostic(error),
        }),
      );
  return true;
}
