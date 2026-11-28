import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import {
  DownloadFailedError,
  DownloadSourceError,
  type AlbumQuery,
  type DownloadSource,
  type ResolvedTrack,
  type Upgrade,
} from "./download/downloadSource.ts";
import { getDownloadClient, getUsenetClient } from "./download/downloadClientSettings.ts";
import { createSearchResultCache } from "./downloadJobs/searchResultCache.ts";
import {
  buildUsenetSearchQueries,
  isAudioFile,
  isProwlarrMusicQuery,
  rankUsenetReleases,
  selectRankedUsenetCandidates,
  type UsenetRelease,
  type UsenetSearchContext,
} from "./downloadJobs/usenetReleaseSearch.ts";
import { logger } from "./logger.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";
import { mergeSearchResults } from "./pipelineHelpers.ts";
import { prowlarrClient } from "./prowlarrClient.ts";
import { orderAdvertisedQualityCandidates } from "./qualityProfileModel.ts";
import { getQualityProfile } from "./qualityProfile.ts";
import { releaseIdentity } from "./tidarrClient.ts";
import { isUsenetClientKey, type NzbSourceId } from "./usenetClientCommon.ts";

const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 5;
const MANUAL_RESULTS = 100;
const SKIPPED_FOLDERS = new Set(["__macosx", ".sync", ".ds_store"]);

const searchResults = createSearchResultCache<UsenetRelease>();

const releaseData = v.object({
  guid: v.nullish(v.string()),
  title: v.string(),
  downloadUrl: v.pipe(v.string(), v.minLength(1)),
  indexerId: v.nullish(v.number()),
  indexer: v.nullish(v.string()),
  score: v.optional(v.number()),
});

type HistoryItem = {
  Status?: string | null;
  status?: string | null;
  FinalDir?: string | null;
  DestDir?: string;
  storage?: string | null;
  path?: string | null;
  folder?: string | null;
  dir?: string | null;
};

const failure = (error: unknown) => asAppError(error)?.message || String(error);

const releaseKey = (release: UsenetRelease) =>
  [release.guid, release.downloadUrl, release.indexerId, release.title]
    .map((entry) =>
      String(entry || "")
        .trim()
        .toLowerCase(),
    )
    .join("\0");

function historyState(item: HistoryItem) {
  const status = String(item.Status || item.status || "").toUpperCase();
  if (["SUCCESS", "WARNING", "COMPLETED"].some((state) => status.startsWith(state)))
    return "success";
  if (["FAILED", "FAILURE", "DELETED"].some((state) => status.startsWith(state))) return "failed";
  return "pending";
}

async function audioFilesUnder(root: string, depth = 0): Promise<string[]> {
  if (depth > 7) return [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && isAudioFile(entry.name))
    .map((entry) => path.join(root, entry.name));
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name.toLowerCase()))
      files.push(...(await audioFilesUnder(path.join(root, entry.name), depth + 1)));
  }
  return files;
}

// The audio files of a finished download, each with its place under the
// download's folder, so the discs of an album keep their own folders.
export async function downloadedAudioFiles(item: HistoryItem, clientKey: string) {
  const mappings = getPathMappings(clientKey);
  const roots = new Set(
    [item.FinalDir, item.DestDir, item.storage, item.path, item.folder, item.dir]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => path.resolve(resolveLocalPath(value, mappings))),
  );
  const found = new Map<string, string>();
  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => null);
    if (stat?.isFile() && isAudioFile(root)) found.set(root, path.basename(root));
    if (!stat?.isDirectory()) continue;
    for (const file of await audioFilesUnder(root))
      if (!found.has(file)) found.set(file, path.relative(root, file));
  }
  return [...found].map(([file, name]) => ({ file, name }));
}

// Like qBittorrent, Aurral links the files into the folder it gave the
// download, or copies them across disks, and the client lets go of its copy.
async function handOver(item: HistoryItem, clientKey: string, directory: string) {
  const files = await downloadedAudioFiles(item, clientKey);
  for (const { file, name } of files) {
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.link(file, target).catch(async (error: unknown) => {
      if (asAppError(error)?.code !== "EEXIST") await fs.copyFile(file, target);
    });
  }
  return files.length;
}

// A release several jobs want is downloaded once. Jobs that want it while it
// downloads share that download; jobs that want it soon after it finished take
// its files from a copy Aurral keeps for a while (hard links next to the
// staging folders), so the download client never holds the same release twice.
const KEPT_RELEASE_MS = 2 * 60 * 60 * 1000;
const KEPT_MAX_BYTES = 10 * 1024 ** 3;
const KEPT = "aurral-kept:";
const KEPT_MARK = ".aurral-kept.json";
const keptName = (identity: string) =>
  createHash("sha256").update(identity).digest("hex").slice(0, 32);
const keptRoot = (directory: string) => path.join(path.dirname(directory), "kept-releases");

// The download each release was sent as while it downloads, and the release
// each download was sent for, so a job sharing a download can still find the
// kept copy after another job let the client remove it. A send is forgotten
// two days after its kept copy would be gone, when the next release is sent.
const SEND_MEMORY_MS = 2 * 24 * 60 * 60 * 1000 + KEPT_RELEASE_MS;
const downloading = new Map<string, string>();
const sentFor = new Map<string, { identity: string; at: number }>();

function rememberSend(identity: string, pendingId: string) {
  const now = Date.now();
  for (const [id, sent] of sentFor) if (now - sent.at > SEND_MEMORY_MS) sentFor.delete(id);
  downloading.set(identity, pendingId);
  sentFor.set(pendingId, { identity, at: now });
}

function sendFinished(pendingId: string) {
  const identity = sentFor.get(pendingId)?.identity;
  if (identity && downloading.get(identity) === pendingId) downloading.delete(identity);
  return identity ?? null;
}

async function keptRelease(directory: string, name: string) {
  const folder = path.join(keptRoot(directory), name);
  const mark = await fs
    .readFile(path.join(folder, KEPT_MARK), "utf8")
    .then((text) => JSON.parse(text) as { at?: number })
    .catch(() => null);
  if (!mark || !Number.isFinite(mark.at) || Date.now() - Number(mark.at) > KEPT_RELEASE_MS)
    return null;
  return folder;
}

async function linkAudio(from: string, to: string) {
  let count = 0;
  for (const file of await audioFilesUnder(from)) {
    const target = path.join(to, path.relative(from, file));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.link(file, target).catch(async (error: unknown) => {
      if (asAppError(error)?.code !== "EEXIST") await fs.copyFile(file, target);
    });
    count += 1;
  }
  return count;
}

// Keeps a finished release for other jobs: links only, so it costs no space
// while a job still holds the files. Copies older than two hours go when a new
// one is kept, and the oldest go while all of them pass 10 GB.
async function keepRelease(identity: string, directory: string) {
  const root = keptRoot(directory);
  const folder = path.join(root, keptName(identity));
  await fs.rm(folder, { recursive: true, force: true });
  for (const file of await audioFilesUnder(directory)) {
    const target = path.join(folder, path.relative(directory, file));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.link(file, target);
  }
  await fs.writeFile(path.join(folder, KEPT_MARK), JSON.stringify({ identity, at: Date.now() }));
  const kept: { folder: string; at: number; bytes: number }[] = [];
  for (const entry of await fs.readdir(root).catch(() => [])) {
    const other = path.join(root, entry);
    if (!(await keptRelease(directory, entry))) {
      await fs.rm(other, { recursive: true, force: true });
      continue;
    }
    const at = (await fs.stat(path.join(other, KEPT_MARK)).catch(() => null))?.mtimeMs ?? 0;
    let bytes = 0;
    for (const file of await audioFilesUnder(other))
      bytes += (await fs.stat(file).catch(() => null))?.size ?? 0;
    kept.push({ folder: other, at, bytes });
  }
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of kept.sort((a, b) => a.at - b.at)) {
    if (total <= KEPT_MAX_BYTES || entry.folder === folder) continue;
    await fs.rm(entry.folder, { recursive: true, force: true });
    total -= entry.bytes;
  }
}

// One release is sent by one job at a time, so jobs that want it together
// find the first job's download instead of sending another.
const sending = new Map<string, Promise<unknown>>();
function oneSendAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (!key) return work();
  const run = (sending.get(key) ?? Promise.resolve()).then(work, work);
  const settled = run.then(
    () => {},
    () => {},
  );
  sending.set(key, settled);
  void settled.then(() => {
    if (sending.get(key) === settled) sending.delete(key);
  });
  return run;
}

function pendingDownload(id: string) {
  const at = id.indexOf(":");
  const key = id.slice(0, at);
  const nzbId = id.slice(at + 1);
  if (at < 1 || !nzbId || !(key === "tidarr" || isUsenetClientKey(key)))
    throw new DownloadSourceError("this isn't one of its downloads");
  return { client: getUsenetClient(key), nzbId };
}

function nzbSource(id: NzbSourceId) {
  const tidarr = id === "tidarr";
  const label = tidarr ? "Tidarr" : "Usenet";
  const searchLabel = tidarr ? "Tidarr" : "Prowlarr";
  const Failed = tidarr ? DownloadSourceError : DownloadFailedError;

  async function search(
    album: AlbumQuery,
    {
      upgrade,
      track,
      denied,
    }: { upgrade: Upgrade; track: ResolvedTrack | null; denied: ReadonlySet<string> },
  ) {
    const albumGrab = !track;
    const context: UsenetSearchContext = track ?? {
      artistName: album.artist,
      albumName: album.title,
      albumTrackCount: album.tracks.length || null,
      releaseTracks: album.tracks,
    };
    const indexers = tidarr
      ? []
      : (await prowlarrClient.getEnabledUsenetIndexers().catch(() => [])).filter(
          (indexer) => indexer.musicSearch,
        );
    const run = (query: string) =>
      tidarr
        ? getDownloadClient("tidarr").search(query)
        : isProwlarrMusicQuery(query)
          ? prowlarrClient.search(query, { type: "music", indexers })
          : prowlarrClient.search(query);
    const quality = {
      profile: getQualityProfile(),
      currentTier: upgrade?.currentTier ?? null,
      upgrade: upgrade !== null,
      readName: (entry: { raw: { release: UsenetRelease } }) => entry.raw.release.title,
    };
    // A release is the exact tracklist, so an album with another track count cannot fill it.
    const trackCount = albumGrab ? album.tracks.length : 0;
    const allowed = (release: UsenetRelease) =>
      !denied.has(releaseIdentity(release.guid)) &&
      (!trackCount || release.tracks == null || release.tracks === trackCount);
    const found: UsenetRelease[] = [];
    const seen = new Set<string>();
    let lastError = "";
    // Tidarr lists an album once per quality, and every listing downloads as the same item.
    const ordered = () => {
      const identities = new Set<string>();
      return orderAdvertisedQualityCandidates(
        rankUsenetReleases(found, context).filter(
          (entry) => entry.releaseAdmissible && (!albumGrab || entry.resolvedAlbumName),
        ),
        quality,
      ).filter((entry) => {
        const identity = releaseIdentity(entry.raw.release.guid);
        if (identities.has(identity)) return false;
        if (identity) identities.add(identity);
        return true;
      });
    };
    for (const query of buildUsenetSearchQueries(context, {
      musicSearch: indexers.length > 0,
      albumGrab,
    })) {
      if (ordered().length >= MIN_CANDIDATES) break;
      const key = `${id}\0${query}`;
      const releases =
        searchResults.get(key) ??
        (await run(query).then(
          (fetched) => {
            searchResults.set(key, fetched);
            return fetched;
          },
          (error: unknown) => {
            lastError = failure(error);
            logger.warn("usenet", `${searchLabel} search failed`, { query, error: lastError });
            return [];
          },
        ));
      mergeSearchResults(found, seen, releases.filter(allowed), releaseKey);
    }
    const candidates = selectRankedUsenetCandidates(ordered(), MAX_CANDIDATES);
    if (candidates.length === 0 && lastError && found.length === 0)
      throw new DownloadSourceError(`${searchLabel} search failed: ${lastError}`);
    return candidates.map(({ raw, score, resolvedAlbumName }) =>
      albumResult(raw.release, resolvedAlbumName, album.artist || context.artistName, score),
    );
  }

  // A download another job sent is worth sharing while the client still has it
  // and it hasn't failed.
  async function stillDownloading(pendingId: string) {
    const { client, nzbId } = pendingDownload(pendingId);
    if (await client.getQueueItem(nzbId).catch(() => null)) return true;
    const item = await client.getHistoryItem(nzbId).catch(() => null);
    return Boolean(item && historyState(item) !== "failed");
  }

  return {
    id,
    staging: id,
    albums: {
      search,
      async manualSearch(album, track) {
        const query = [track.artistName, track.trackName, track.albumName]
          .filter(Boolean)
          .join(" ");
        const releases = tidarr
          ? await getDownloadClient("tidarr").search(query)
          : await prowlarrClient.search(query, { limit: MANUAL_RESULTS });
        return releases.map((release) =>
          albumResult(release, null, album.artist || track.artistName, 0),
        );
      },
      async download({ result, directory }) {
        const parsed = v.safeParse(releaseData, result.data);
        if (!parsed.success) throw new DownloadSourceError("No Usenet release URL available");
        const release = parsed.output;
        const indexerClient = tidarr
          ? null
          : prowlarrClient.getIndexerDownloadClient(release.indexerId);
        const client = tidarr ? getDownloadClient("tidarr") : getUsenetClient(indexerClient);
        if (indexerClient && !client.isConfigured())
          throw new DownloadSourceError(`${client.name} is not set up`);
        const identity = releaseIdentity(release.guid) || release.downloadUrl;
        const send = async () => {
          try {
            const nzb = tidarr
              ? await getDownloadClient("tidarr").fetchNzb(release.guid)
              : await prowlarrClient.downloadNzb(release.downloadUrl, release);
            const { nzbId } = await client.appendNzb({
              name: release.title,
              content: nzb,
              dupeKey: `aurral-${path.basename(directory)}`,
              dupeScore: release.score ?? 0,
            });
            const pending = `${client.key}:${nzbId}`;
            rememberSend(identity, pending);
            return { pending };
          } catch (error) {
            logger.warn("usenet", "Usenet release could not be sent to the download client", {
              client: client.key,
              releaseTitle: release.title,
              error: failure(error),
            });
            throw new DownloadSourceError(failure(error));
          }
        };
        return oneSendAtATime(identity, async () => {
          if (await keptRelease(directory, keptName(identity)))
            return { pending: `${client.key}:${KEPT}${keptName(identity)}` };
          const running = downloading.get(identity);
          if (running?.startsWith(`${client.key}:`) && (await stillDownloading(running))) {
            logger.info("usenet", "Another job is already downloading this release; sharing it", {
              client: client.key,
              releaseTitle: release.title,
            });
            return { pending: running };
          }
          return send();
        });
      },
    },
    // A queued, paused, slow, or post-processing download keeps waiting like
    // it would in Lidarr. One that left both the queue and the history is
    // gone, read twice because a download moves from one to the other.
    async status({ id: pendingId, directory }) {
      const { client, nzbId } = pendingDownload(pendingId);
      if (nzbId.startsWith(KEPT)) {
        const kept = await keptRelease(directory, nzbId.slice(KEPT.length));
        if (kept && (await linkAudio(kept, directory)) > 0) return { done: true };
        throw new DownloadSourceError(`The ${label} release Aurral kept for reuse is gone`);
      }
      let item: HistoryItem | null = await client.getHistoryItem(nzbId);
      if (!item) {
        if (await client.getQueueItem(nzbId)) return { done: false };
        item = await client.getHistoryItem(nzbId);
        if (!item) {
          // a job sharing this download finished it and let the client remove it
          const identity = sendFinished(pendingId);
          const kept = identity ? await keptRelease(directory, keptName(identity)) : null;
          if (kept && (await linkAudio(kept, directory)) > 0) return { done: true };
          throw new DownloadSourceError(`The ${label} download left the download client`);
        }
      }
      const state = historyState(item);
      if (state === "pending") return { done: false };
      const identity = sendFinished(pendingId);
      if (state === "failed")
        throw new Failed(`${label} download failed: ${item.Status || item.status || "failed"}`);
      const files = await handOver(item, client.key, directory);
      if (files > 0 && identity)
        await keepRelease(identity, directory).catch((error: unknown) =>
          logger.warn("usenet", "Could not keep a finished release for other jobs", {
            reason: failure(error),
          }),
        );
      await client
        .deleteHistoryItem(nzbId, { deleteFiles: true, historyItem: item })
        .catch((error: unknown) =>
          logger.warn("usenet", `Could not remove the ${client.key} history item`, {
            nzbId,
            reason: failure(error),
          }),
        );
      if (files === 0)
        throw new DownloadSourceError(`${label} download completed without audio files`);
      return { done: true };
    },
    // A download Aurral no longer wants leaves the client with its files.
    // Removal counts only once the client confirms it or no longer lists it.
    async discard(pendingId) {
      const { client, nzbId } = pendingDownload(pendingId);
      if (nzbId.startsWith(KEPT)) return;
      if (!client.isConfigured()) throw new Error(`${client.name} is not configured`);
      for (const [remove, lookup] of [
        [() => client.deleteQueueItem(nzbId), () => client.getQueueItem(nzbId)],
        [
          () => client.deleteHistoryItem(nzbId, { deleteFiles: true }),
          () => client.getHistoryItem(nzbId),
        ],
      ] satisfies [() => Promise<unknown>, () => Promise<unknown>][]) {
        if (!(await remove()) && (await lookup()))
          throw new Error(`${client.name} did not confirm item removal`);
      }
    },
  } satisfies DownloadSource;
}

function albumResult(
  release: UsenetRelease,
  album: string | null,
  artist: string | null | undefined,
  score: number,
) {
  const title = String(release.title || "").trim();
  return {
    id: releaseIdentity(release.guid) || String(release.downloadUrl || title),
    title: album || title,
    artist: String(artist || "").trim() || title,
    trackCount: release.tracks ?? null,
    data: {
      guid: release.guid ?? null,
      title,
      downloadUrl: release.downloadUrl ?? "",
      indexerId: release.indexerId ?? null,
      indexer: release.indexer ?? null,
      score,
    },
  };
}

export const usenetSource = nzbSource("usenet");
export const tidarrSource = nzbSource("tidarr");

const legacyStep = v.looseObject({
  phase: v.string(),
  nzbId: v.nullish(v.union([v.string(), v.number()])),
  downloadClient: v.nullish(v.string()),
  manualDownloadClient: v.nullish(v.string()),
  candidates: v.nullish(v.array(v.looseObject({ raw: v.unknown() }))),
});

// A step queued before Usenet used the download source contract searches
// again, and the download it started leaves the client.
export async function removeLegacyUsenetDownload(payload: unknown) {
  const step = v.safeParse(legacyStep, payload);
  if (!step.success || step.output.phase === "search") return false;
  const { nzbId, candidates } = step.output;
  const releases = (candidates ?? []).some(
    ({ raw }) => typeof raw === "object" && raw !== null && "release" in raw,
  );
  if (nzbId == null && !releases) return false;
  if (nzbId != null) {
    const client = getUsenetClient(
      step.output.downloadClient || step.output.manualDownloadClient || null,
    );
    for (const remove of [
      () => client.deleteQueueItem(nzbId),
      () => client.deleteHistoryItem(nzbId, { deleteFiles: true }),
    ])
      await remove().catch((error: unknown) =>
        logger.warn("usenet", "Could not remove a download started before an update", {
          nzbId,
          reason: failure(error),
        }),
      );
  }
  return true;
}
