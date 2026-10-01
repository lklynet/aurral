import { getArtistRecordId } from "./artistTaste";

export const AUTOCOMPLETE_DEBOUNCE_MS = 250;
export const LIBRARY_AUTOCOMPLETE_DEBOUNCE_MS = 80;
export const SUGGEST_LIMIT = 5;
export const TAG_SUGGESTIONS_LIMIT = 8;
export const ALBUM_PENDING_STATUSES = new Set([
  "searching",
  "downloading",
  "processing",
]);

export function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return ["input", "textarea", "select"].includes(tagName);
}

export function getSuggestionTitle(item) {
  if (item?.type === "artist") return item.name || "";
  if (item?.type === "album") return item.title || "";
  if (item?.type === "track") return item.title || "";
  if (item?.type === "playlist") return item.name || "";
  return "";
}

export function getSuggestionMeta(item) {
  if (item?.type === "artist") return "Artist";
  if (item?.type === "album") {
    return item.artistName ? `Album · ${item.artistName}` : "Album";
  }
  if (item?.type === "track") {
    return item.artistName ? `Song · ${item.artistName}` : "Song";
  }
  if (item?.type === "playlist") {
    return item.trackCount != null
      ? `Playlist · ${item.trackCount} track${item.trackCount === 1 ? "" : "s"}`
      : "Playlist";
  }
  return null;
}

export function getSuggestionItemId(item) {
  if (!item) return "";
  if (item.type === "artist") return getArtistRecordId(item) || "";
  if (item.type === "track") return item.id || item.trackMbid || "";
  return item.id || "";
}

export function getTrackSavingKey(track) {
  return String(
    track?.id ||
      track?.trackMbid ||
      `${track?.artistName || ""}:${track?.title || ""}`,
  );
}

import { isAlbumCompleteInLibrary } from "./albumAddAction";

export function isSuggestionInLibrary(item) {
  if (!item) return false;
  if (item.type === "album") {
    return isAlbumCompleteInLibrary({ status: item.status });
  }
  if (item.inLibrary) return true;
  return false;
}

export function buildTrackPlaylistPayload(track) {
  const payload = {
    artistName: track?.artistName || "",
    trackName: track?.title || "",
    albumName: track?.albumTitle || "",
    artistMbid: track?.artistMbid || "",
    albumMbid: track?.albumMbid || "",
    trackMbid: track?.id || track?.trackMbid || "",
    releaseYear: track?.releaseYear || null,
    durationMs:
      track?.durationMs != null && Number.isFinite(Number(track.durationMs))
        ? Number(track.durationMs)
        : null,
    reason: null,
    artistAliases: [],
  };
  if (!payload.artistName || !payload.trackName) return null;
  return payload;
}
