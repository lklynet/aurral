import { groupSoulseekSearchResults } from "./downloadJobs/trackSearchQueries.js";
import { getFileExtension, getPathParts } from "./trackMatching/candidateNormalizer.js";
import {
  MATCH_POLICY,
  normalizeMatchText,
  parseListingTitle,
} from "./trackMatching/nativeMatcher.js";
import {
  getAdvertisedQualityRank,
  isAdvertisedQualityEligible,
} from "./qualityProfileModel.js";
import { manifestIndexFor, mapRequest } from "./releaseManifest.js";
import { judgeRelease, releaseHolds } from "./trackMatching/releaseJudge.js";
import { coreAlbumTitle, discFolderNumber, inOtherScript, labelSpells } from "./trackMatching/titleText.js";

const AUDIO_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".ogg", ".wav", ".aac", ".opus", ".alac", ".ape", ".wma"]);
const MAX_FOLDER_CANDIDATES = 3;

function requestedArtistNames(manifest) {
  return [...new Set([...(manifest.artistNames || []), ...manifest.tracks.flatMap((track) =>
    [...(track.artists || []), ...(track.artistAliases || [])])]
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

const albumLabel = (folder) => String(folder.directoryPath || "").split(/[\\/]/).at(-1);

// Only a folder named for the album, spaced or not ("LP 4" for "LP4"), goes
// to the judge, unless the name cannot be compared: a title with no letters,
// such as "÷", or a folder named in another script.
function folderMayHoldAlbum(folder, manifest) {
  const albumName = normalizeMatchText(coreAlbumTitle(manifest.title));
  return !albumName || inOtherScript(albumLabel(folder), manifest.title)
    || folderLabels(folder).some((label) => labelSpells(label, albumName));
}

function groupAlbumDiscFolders(groups, manifest) {
  const albums = new Map();
  for (const group of groups) {
    const parts = String(group.directoryPath || "").split("/");
    const discDirectory = discFolderNumber(parts.at(-1), { album: manifest.title }) != null;
    const directoryPath = discDirectory && parts.length > 1
      ? parts.slice(0, -1).join("/") : group.directoryPath;
    const key = `${group.user}\0${directoryPath}`;
    const album = albums.get(key) || { ...group, directoryPath, files: [], audioFiles: [] };
    album.files.push(...group.files);
    album.audioFiles.push(...group.audioFiles);
    albums.set(key, album);
  }
  return [...albums.values()];
}

// A folder that names the requested artist vouches for the artist of files
// whose names carry only a title.
function soulseekFile(item, names, artistFromFolder, manifest) {
  const parsed = parseListingTitle(item.file, { album: manifest.title });
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
  const credited = manifest.compilation && !artist ? /^(.+?)\s+[-–—]\s+(.+)$/u.exec(title) : null;
  if (credited) [, artist, title] = credited;
  const seconds = Number(item.length);
  return {
    title,
    artists: [artist || artistFromFolder].filter(Boolean),
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    sizeBytes: Number(item.size) || null,
    trackNumber: parsed.trackNumber,
    discNumber: parsed.discNumber || null,
    path: item.file,
    filename: getPathParts(item.file).at(-1),
    raw: item,
  };
}

export function buildSoulseekReleaseFolders(results, manifest) {
  if (!manifest?.tracks?.length) return [];
  const names = requestedArtistNames(manifest);
  return groupAlbumDiscFolders(groupSoulseekSearchResults(results, {
    isAudioFile: (filePath) => AUDIO_EXTENSIONS.has(getFileExtension(filePath)),
  }), manifest).flatMap((group) => {
    if (!folderMayHoldAlbum(group, manifest)) return [];
    const artist = manifest.compilation ? null : folderArtist(group, names);
    const files = group.files.filter((item) => AUDIO_EXTENSIONS.has(getFileExtension(item.file)))
      .map((item) => soulseekFile(item, names, artist, manifest));
    const unnamed = !manifest.compilation && !artist && !files.some((file) => file.artists.length);
    if (unnamed && !names.every((name) => inOtherScript(name, group.directoryPath))) return [];
    return [{ group, listing: { artistLabel: artist, albumLabel: albumLabel(group), files } }];
  });
}

// The files of every folder that holds the job's place on the pinned release,
// whole or missing only other tracks, keyed by user and path.
export function soulseekReleaseCopies(results, manifest, job) {
  const index = manifest ? manifestIndexFor(manifest, job) : null;
  if (index == null) return new Set();
  return new Set(buildSoulseekReleaseFolders(results, manifest)
    .filter(({ listing }) => releaseHolds(manifest, listing, index))
    .flatMap(({ group, listing }) => listing.files.map((file) => `${group.user}\0${file.path}`)));
}

function peerOrder(option) {
  const raw = option.files[0] || {};
  return {
    freeSlot: Number(raw.slots) > 0 ? 0 : 1,
    queueLength: Number(raw.queueLength) || 0,
    speed: Number(raw.speed) || 0,
  };
}

function compareFolderOptions(left, right) {
  const leftPeer = peerOrder(left);
  const rightPeer = peerOrder(right);
  return left.qualityRank - right.qualityRank
    || right.fit - left.fit
    || leftPeer.freeSlot - rightPeer.freeSlot
    || leftPeer.queueLength - rightPeer.queueLength
    || rightPeer.speed - leftPeer.speed;
}

export function selectSoulseekAlbumFolder(results, jobs, { manifest = null, profile = null } = {}) {
  if (!Array.isArray(jobs) || !jobs.length || !manifest?.tracks?.length) {
    return { decision: "skip", selected: null, candidates: [] };
  }
  const { wanted, offManifest } = mapRequest(manifest, jobs);
  if (!wanted.size || offManifest.length) return { decision: "skip", selected: null, candidates: [] };
  const qualityAllowed = (item) => item.locked !== true && item.isLocked !== true
    && (!profile || isAdvertisedQualityEligible(item.file, item.bitrate ?? item.bitRate, { profile }));
  const options = buildSoulseekReleaseFolders(results, manifest).flatMap(({ group, listing }) => {
    if (listing.files.length < manifest.tracks.length) return [];
    const assessment = judgeRelease(manifest, listing);
    if (assessment.kind !== "exact") return [];
    const files = [];
    for (const [trackIndex, jobId] of wanted) {
      const copies = assessment.copiesForTrack[trackIndex].map((index) => listing.files[index].raw)
        .filter(qualityAllowed);
      copies.sort((left, right) => profile
        ? getAdvertisedQualityRank(left.file, left.bitrate ?? left.bitRate, profile)
          - getAdvertisedQualityRank(right.file, right.bitrate ?? right.bitRate, profile)
        : 0);
      if (!copies.length) return [];
      files.push({ ...copies[0], jobId });
    }
    return [{ group, files, fit: assessment.fit,
      qualityRank: profile ? Math.max(...files.map((file) =>
        getAdvertisedQualityRank(file.file, file.bitrate ?? file.bitRate, profile))) : 0,
    }];
  }).sort(compareFolderOptions);
  const seenFolders = new Set();
  const seenUsers = new Set();
  const candidates = [];
  for (const option of options) {
    const group = option.group;
    const folderKey = `${group.user}\0${group.directoryPath}`;
    if (seenFolders.has(folderKey) || seenUsers.has(group.user)) continue;
    seenFolders.add(folderKey);
    seenUsers.add(group.user);
    candidates.push(option);
    if (candidates.length >= MAX_FOLDER_CANDIDATES) break;
  }
  return {
    decision: candidates.length > 0 ? "selectable" : "skip",
    selected: candidates[0] || null,
    candidates,
    policyVersion: MATCH_POLICY.version,
  };
}
