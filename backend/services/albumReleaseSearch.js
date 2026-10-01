import { groupFlowSearchResults } from "./weeklyFlow/weeklyFlowSoulseekSearch.js";
import { getFileExtension } from "./trackMatching/candidateNormalizer.js";
import {
  normalizeMatchText,
  parseListingTitle,
  selectReleaseSession,
} from "./trackMatching/nativeMatcher.js";

const AUDIO_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".ogg", ".wav", ".aac", ".opus", ".alac", ".ape", ".wma"]);

function folderFitsRequest(folder, jobs) {
  const names = jobs.flatMap((job) => [job.artistName, ...(job.artistAliases || [])])
    .map(normalizeMatchText).filter(Boolean);
  const albumName = normalizeMatchText(jobs[0].albumName);
  return String(folder.directoryPath || "").split(/[\\/]/).some((segment) => {
    const label = normalizeMatchText(segment);
    return names.some((name) => ` ${label} `.includes(` ${name} `))
      || (albumName && label === albumName);
  });
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

function soulseekFile(item, jobs) {
  const parsed = parseListingTitle(item.file);
  const names = jobs.flatMap((job) => [job.artistName, ...(job.artistAliases || [])]).filter(Boolean);
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
  const seconds = Number(item.length);
  return {
    title,
    artists: artist ? [artist] : [],
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    trackNumber: parsed.trackNumber,
    raw: item,
  };
}

export function selectSoulseekAlbumFolder(results, jobs) {
  if (!Array.isArray(jobs) || jobs.length < 2) return { decision: "skip", selected: null };
  const leader = jobs[0];
  const tracks = jobs.map((job) => ({
    title: job.trackName,
    artists: [job.artistName].filter(Boolean),
    artistAliases: job.artistAliases || [],
    durationMs: job.durationMs,
    recordingMbid: job.trackMbid,
    trackNumber: job.trackNumber,
  }));
  const groups = groupAlbumDiscFolders(groupFlowSearchResults(results, {
    isAudioFile: (filePath) => AUDIO_EXTENSIONS.has(getFileExtension(filePath)),
  }));
  const folders = groups.filter((group) => folderFitsRequest(group, jobs)).map((group) => ({
    rawGroup: group,
    files: group.audioFiles.map((item) => soulseekFile(item, jobs)),
  }));
  const result = selectReleaseSession({
    releases: [{ tracks }], folders,
    requestedRecordingMbid: leader.trackMbid || null,
  });
  return {
    decision: result.decision,
    selected: result.selected ? {
      group: result.selected.folder.rawGroup,
      files: result.selected.assessment.assignment.pairs.map((pair) =>
        result.selected.folder.files[pair.fileIndex].raw),
      coverage: result.selected.assessment.coverage,
      fit: result.selected.assessment.fit,
    } : null,
    policyVersion: result.policyVersion,
  };
}
