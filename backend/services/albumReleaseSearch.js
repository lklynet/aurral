import { groupSoulseekSearchResults } from "./downloadJobs/trackSearchQueries.js";
import { getFileExtension } from "./trackMatching/candidateNormalizer.js";
import {
  normalizeMatchText,
  parseListingTitle,
  selectReleaseSession,
} from "./trackMatching/nativeMatcher.js";
import {
  getAdvertisedQualityRank,
  isAdvertisedQualityEligible,
} from "./qualityProfileModel.js";
import { candidateReleasesForJobs, isCompilationJobs } from "./albumReleases.js";
import { coreAlbumTitle } from "./trackMatching/titleText.js";

const AUDIO_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".ogg", ".wav", ".aac", ".opus", ".alac", ".ape", ".wma"]);
const MAX_FOLDER_CANDIDATES = 3;

function requestedArtistNames(jobs) {
  return [...new Set(jobs.flatMap((job) => [job.artistName, ...(job.artistAliases || [])])
    .map((name) => String(name || "").trim()).filter(Boolean))];
}

function folderLabels(folder) {
  return String(folder.directoryPath || "").split(/[\\/]/).map(normalizeMatchText);
}

function folderArtist(folder, names) {
  const labels = folderLabels(folder);
  return names.find((name) => {
    const key = normalizeMatchText(name);
    return key && labels.some((label) => ` ${label} `.includes(` ${key} `));
  }) || null;
}

function folderNamesAlbum(folder, jobs) {
  const albumName = normalizeMatchText(coreAlbumTitle(jobs[0].albumName));
  return Boolean(albumName)
    && folderLabels(folder).some((label) => ` ${label} `.includes(` ${albumName} `));
}

function groupAlbumDiscFolders(groups) {
  const albums = new Map();
  for (const group of groups) {
    const parts = String(group.directoryPath || "").split("/");
    const discDirectory = /^(?:cd|disc|disk)\s*0*\d{1,2}(?:\s*of\s*\d+)?$/iu.test(parts.at(-1));
    const directoryPath = discDirectory && parts.length > 1
      ? parts.slice(0, -1).join("/") : group.directoryPath;
    const key = `${group.user}\0${directoryPath}`;
    const album = albums.get(key) || { ...group, directoryPath, audioFiles: [] };
    album.audioFiles.push(...group.audioFiles);
    albums.set(key, album);
  }
  return [...albums.values()];
}

// A folder that names the requested artist vouches for the artist of files
// whose names carry only a title.
function soulseekFile(item, names, artistFromFolder, compilation) {
  const parsed = parseListingTitle(item.file);
  let title = parsed.title || "";
  let artist = null;
  for (const name of names) {
    const prefix = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+[-–—]\\s+`, "iu");
    if (prefix.test(title)) {
      title = title.replace(prefix, "");
      artist = name;
      break;
    }
  }
  const credited = compilation && !artist ? /^(.+?)\s+[-–—]\s+(.+)$/u.exec(title) : null;
  if (credited) [, artist, title] = credited;
  const seconds = Number(item.length);
  return {
    title,
    artists: [artist || artistFromFolder].filter(Boolean),
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    trackNumber: parsed.trackNumber,
    raw: item,
  };
}

function peerOrder(option) {
  const raw = option.folder.files[0]?.raw || {};
  return {
    freeSlot: Number(raw.slots) > 0 ? 0 : 1,
    queueLength: Number(raw.queueLength) || 0,
    speed: Number(raw.speed) || 0,
  };
}

// A complete copy comes first, then the best quality in the profile, then
// the closest fit, then the peer most likely to upload soon.
function compareFolderOptions(left, right) {
  const leftPeer = peerOrder(left);
  const rightPeer = peerOrder(right);
  return right.assessment.coverage - left.assessment.coverage
    || left.folder.qualityRank - right.folder.qualityRank
    || right.assessment.fit - left.assessment.fit
    || leftPeer.freeSlot - rightPeer.freeSlot
    || leftPeer.queueLength - rightPeer.queueLength
    || rightPeer.speed - leftPeer.speed;
}

export function selectSoulseekAlbumFolder(results, jobs, { releases = [], profile = null } = {}) {
  if (!Array.isArray(jobs) || jobs.length < 2) {
    return { decision: "skip", selected: null, candidates: [] };
  }
  const leader = jobs[0];
  const names = requestedArtistNames(jobs);
  const compilation = isCompilationJobs(jobs);
  const qualityAllowed = (item) => !profile
    || isAdvertisedQualityEligible(item.file, item.bitrate ?? item.bitRate, { profile });
  const groups = groupAlbumDiscFolders(groupSoulseekSearchResults(results, {
    isAudioFile: (filePath) => AUDIO_EXTENSIONS.has(getFileExtension(filePath)),
  }));
  const folders = groups.flatMap((group) => {
    const artist = compilation ? null : folderArtist(group, names);
    if (!artist && !folderNamesAlbum(group, jobs)) return [];
    const audioFiles = group.audioFiles.filter(qualityAllowed);
    if (audioFiles.length === 0) return [];
    return [{
      rawGroup: group,
      files: audioFiles.map((item) => soulseekFile(item, names, artist, compilation)),
      qualityRank: profile
        ? Math.max(...audioFiles.map((item) =>
          getAdvertisedQualityRank(item.file, item.bitrate ?? item.bitRate, profile)))
        : 0,
    }];
  });
  const candidateReleases = candidateReleasesForJobs(jobs, releases);
  const result = selectReleaseSession({
    releases: candidateReleases,
    folders,
    requestedRecordingMbid: leader.trackMbid || null,
    compare: compareFolderOptions,
  });
  const seenFolders = new Set();
  const seenUsers = new Set();
  const candidates = [];
  for (const option of result.options) {
    const group = option.folder.rawGroup;
    const folderKey = `${group.user}\0${group.directoryPath}`;
    if (seenFolders.has(folderKey) || seenUsers.has(group.user)) continue;
    seenFolders.add(folderKey);
    seenUsers.add(group.user);
    candidates.push({
      group,
      files: option.assessment.assignment.pairs.map((pair) => ({
        ...option.folder.files[pair.fileIndex].raw,
        jobId: jobs[pair.trackIndex].id,
      })),
      coverage: option.assessment.coverage,
      fit: option.assessment.fit,
      releaseId: option.release.id,
    });
    if (candidates.length >= MAX_FOLDER_CANDIDATES) break;
  }
  return {
    decision: candidates.length > 0 ? "selectable" : "skip",
    selected: candidates[0] || null,
    candidates,
    policyVersion: result.policyVersion,
  };
}
