import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { http } from "../../lib/http.ts";
import { asAppError } from "../../lib/errors.ts";
import {
  DownloadSourceError,
  type AlbumQuery,
  type DownloadSource,
  type Upgrade,
} from "./download/downloadSource.ts";
import {
  buildUsenetSearchQueries,
  isAudioFile,
  isProwlarrMusicQuery,
  rankUsenetReleases,
} from "./downloadJobs/usenetReleaseSearch.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";
import { prowlarrClient } from "./prowlarrClient.ts";
import { orderAdvertisedQualityCandidates } from "./qualityProfileModel.ts";
import { getQualityProfile } from "./qualityProfile.ts";
import { qbittorrentClient } from "./qbittorrentClient.ts";

const releaseData = v.object({
  downloadUrl: v.nullish(v.string()),
  magnetUrl: v.nullish(v.string()),
});

const BUSY_STATES = new Set(["checkingUP", "checkingDL", "checkingResumeData", "moving", "metaDL"]);
const FAILED_STATES = new Set(["error", "missingFiles"]);
const STOPPED_STATES = new Set(["stoppedUP", "pausedUP"]);
const IMPORTED_TAG = "aurral-imported";

const failure = (error: unknown) => asAppError(error)?.message || String(error);

async function searchReleases(album: AlbumQuery, upgrade: Upgrade) {
  const indexers = await prowlarrClient.getEnabledTorrentIndexers();
  if (indexers.length === 0)
    throw new DownloadSourceError("Prowlarr has no torrent indexers turned on");
  const musicIndexers = indexers.filter((indexer) => indexer.musicSearch);
  const context = {
    artistName: album.artist,
    albumName: album.title,
    releaseTracks: album.tracks,
  };
  const queries = buildUsenetSearchQueries(context, {
    musicSearch: musicIndexers.length > 0,
    albumGrab: true,
  });
  for (const query of queries) {
    const releases = await prowlarrClient.search(
      query,
      isProwlarrMusicQuery(query)
        ? { protocol: "torrent", type: "music", indexers: musicIndexers }
        : { protocol: "torrent", indexers },
    );
    const ranked = rankUsenetReleases(
      releases
        .filter((release) => release.seeders !== 0)
        .map((release) => ({
          ...release,
          downloadUrl: release.downloadUrl || release.magnetUrl || "",
        })),
      context,
      { protocol: "torrent" },
    ).filter((entry) => entry.releaseAdmissible && entry.resolvedAlbumName);
    const ordered = orderAdvertisedQualityCandidates(ranked, {
      profile: getQualityProfile(),
      currentTier: upgrade?.currentTier ?? null,
      upgrade: upgrade !== null,
      readName: (entry) => entry.raw.release.title,
    });
    if (ordered.length > 0) return ordered;
  }
  return [];
}

// Like Lidarr, Aurral fetches the torrent itself, so qBittorrent never needs
// to reach Prowlarr. Prowlarr links to a magnet through a redirect.
async function fetchTorrent(data: v.InferOutput<typeof releaseData>) {
  const link = data.downloadUrl || data.magnetUrl || "";
  if (link.startsWith("magnet:")) return { magnet: link };
  const response = await http.get(link, {
    responseType: "buffer",
    timeoutMs: 60000,
    okStatus: () => true,
  });
  const location = response.headers.location ?? "";
  if (location.startsWith("magnet:")) return { magnet: location };
  if (response.status !== 200 || !Buffer.isBuffer(response.data))
    throw new DownloadSourceError(`The indexer didn't return the torrent: HTTP ${response.status}`);
  return { file: response.data };
}

async function taggedTorrent(tag: string) {
  const [torrent] = await qbittorrentClient.torrentsTagged(tag);
  if (!torrent) throw new DownloadSourceError("qBittorrent no longer has the torrent");
  return torrent;
}

// The finished download stays in qBittorrent to seed. Aurral links the audio
// files it kept into the folder it gave the download, or copies them across
// disks.
async function linkAudioFiles(torrent: { hash: string; save_path: string }, directory: string) {
  const files = (await qbittorrentClient.torrentFiles(torrent.hash)).filter(
    (file) =>
      file.priority > 0 &&
      isAudioFile(file.name) &&
      !path.relative(directory, path.join(directory, file.name)).startsWith(".."),
  );
  if (files.length === 0) throw new DownloadSourceError("The torrent has no audio files");
  const mappings = getPathMappings("qbittorrent");
  for (const file of files) {
    const from = resolveLocalPath(`${torrent.save_path}/${file.name}`, mappings);
    const target = path.join(directory, file.name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs
      .link(from, target)
      .catch(() => fs.copyFile(from, target))
      .catch(() => {
        throw new DownloadSourceError(
          `Aurral can't find ${from}. Add a remote path mapping for qBittorrent.`,
        );
      });
  }
}

export const qbittorrentSource = {
  id: "qbittorrent",
  staging: "qbittorrent",
  albums: {
    async search(album, upgrade) {
      const ranked = await searchReleases(album, upgrade).catch((error: unknown) => {
        if (error instanceof DownloadSourceError) throw error;
        throw new DownloadSourceError(`Prowlarr search failed: ${failure(error)}`);
      });
      return ranked.map(({ raw, resolvedAlbumName }) => ({
        id: raw.release.guid || String(raw.downloadUrl),
        title: String(resolvedAlbumName),
        artist: album.artist || raw.release.title,
        data: { downloadUrl: raw.release.downloadUrl, magnetUrl: raw.release.magnetUrl },
      }));
    },
    async download({ result }) {
      const tag = `aurral-${randomUUID()}`;
      const added = await qbittorrentClient.addTorrent(
        await fetchTorrent(v.parse(releaseData, result.data)),
        tag,
      );
      if (!added) throw new DownloadSourceError("qBittorrent didn't add the torrent");
      return { pending: tag };
    },
    files: {
      async list(id) {
        const [torrent] = await qbittorrentClient.torrentsTagged(id);
        const files = torrent ? await qbittorrentClient.torrentFiles(torrent.hash) : [];
        return files.length > 0 ? files.map(({ name, size }) => ({ path: name, size })) : null;
      },
      // A magnet stops once qBittorrent has its files, so nothing downloads
      // before Aurral keeps the ones it wants.
      async keep({ id, paths }) {
        const torrent = await taggedTorrent(id);
        const files = await qbittorrentClient.torrentFiles(torrent.hash);
        await qbittorrentClient.skipFiles(
          torrent.hash,
          files.filter((file) => !paths.includes(file.name)).map((file) => file.index),
        );
        await qbittorrentClient.startTorrent(torrent.hash);
      },
    },
  },
  async status({ id, directory }) {
    const torrent = await taggedTorrent(id);
    if (FAILED_STATES.has(torrent.state))
      throw new DownloadSourceError(`qBittorrent stopped the torrent: ${torrent.state}`);
    if (torrent.progress < 1 || BUSY_STATES.has(torrent.state)) return { done: false };
    await linkAudioFiles(torrent, directory);
    await qbittorrentClient.addTag(torrent.hash, IMPORTED_TAG);
    return { done: true };
  },
  async discard(id) {
    const torrents = await qbittorrentClient.torrentsTagged(id);
    await qbittorrentClient.deleteTorrents(torrents.map((torrent) => torrent.hash));
  },
} satisfies DownloadSource;

// As in Lidarr, qBittorrent stops a torrent at its seeding limit, and Aurral
// then removes it. Only a torrent Aurral took its files from is marked, so a
// download still in progress is never removed.
export async function removeSeededTorrents() {
  if (!qbittorrentClient.isConfigured()) return;
  const torrents = await qbittorrentClient.torrentsTagged(IMPORTED_TAG);
  await qbittorrentClient.deleteTorrents(
    torrents
      .filter((torrent) => torrent.progress >= 1 && STOPPED_STATES.has(torrent.state))
      .map((torrent) => torrent.hash),
  );
}
