import { UUID_REGEX } from "./uuid.ts";

export const MAX_SHARE_TRACKS = 2000;
export const MAX_SHARE_BYTES = 768 * 1024;
export const SHARE_PATH_PATTERN = /^tracks\/[1-9]\d*\/[1-9]\d*$/;
export const SHARE_CODE_PATTERN = /^s[A-Za-z0-9_-]{15}$/;

export const getShareCode = (token: string) => `s${token.slice(0, 15)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/\p{Cc}/gu, " ")
        .trim()
        .slice(0, 300)
    : "";
const mbid = (value: unknown) =>
  typeof value === "string" && UUID_REGEX.test(value) ? value : null;
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

export function parseShareTrack(value: unknown) {
  const track = isRecord(value) ? value : {};
  const title = text(track.title);
  const artistName = text(track.artistName);
  if (!title || !artistName) return null;
  return {
    title,
    artistName,
    albumTitle: text(track.albumTitle) || null,
    albumArtistName: text(track.albumArtistName) || artistName,
    trackMbid: mbid(track.trackMbid),
    albumMbid: mbid(track.albumMbid),
    artistMbid: mbid(track.artistMbid),
    releaseMbid: mbid(track.releaseMbid),
    durationMs: positive(track.durationMs),
    discNumber: positive(track.discNumber) || 1,
    trackNumber: positive(track.trackNumber),
    path: typeof track.path === "string" && SHARE_PATH_PATTERN.test(track.path) ? track.path : null,
    size: positive(track.size),
    format: text(track.format).toLowerCase() || null,
  };
}

export function parseShareManifest(value: unknown) {
  const item = isRecord(value) ? value : {};
  const { kind } = item;
  if (kind !== "track" && kind !== "album" && kind !== "artist" && kind !== "playlist") return null;
  const title = text(item.title) || (kind === "artist" ? text(item.artistName) : "");
  const artistName = text(item.artistName);
  if (!title || (kind !== "playlist" && !artistName)) return null;
  if (item.tracks !== undefined && !Array.isArray(item.tracks)) return null;
  const input: unknown[] = Array.isArray(item.tracks) ? item.tracks : [];
  if (input.length > MAX_SHARE_TRACKS) return null;
  const tracks = input.map(parseShareTrack);
  if (tracks.some((track) => !track)) return null;
  return {
    version: 1,
    kind,
    title,
    artistName,
    albumTitle: text(item.albumTitle) || null,
    trackMbid: mbid(item.trackMbid),
    albumMbid: mbid(item.albumMbid),
    artistMbid: mbid(item.artistMbid),
    tracks: tracks.filter((track) => track !== null),
  } satisfies { kind: typeof kind } & Record<string, unknown>;
}

export type ShareManifest = NonNullable<ReturnType<typeof parseShareManifest>>;
export type SharedTrack = ShareManifest["tracks"][number];

type ShareTrackIdentity = Pick<
  SharedTrack,
  "title" | "artistName" | "trackMbid" | "albumMbid" | "releaseMbid" | "albumTitle"
>;

export function findSharedTrack<T extends ShareTrackIdentity>(
  tracks: T[],
  requested: ShareTrackIdentity,
) {
  return tracks.find((track) => {
    const sameTrack = requested.trackMbid
      ? requested.trackMbid === track.trackMbid
      : requested.title.toLowerCase() === track.title.toLowerCase() &&
        requested.artistName.toLowerCase() === track.artistName.toLowerCase();
    const sameAlbum = requested.releaseMbid
      ? requested.releaseMbid === track.releaseMbid
      : requested.albumMbid
        ? requested.albumMbid === track.albumMbid
        : !requested.albumTitle ||
          requested.albumTitle.toLowerCase() === track.albumTitle?.toLowerCase();
    return sameTrack && sameAlbum;
  });
}
