// Projections of provider resources stored in library `metadata_json`.
//
// Lidarr resources embed whole related objects (an album carries its full
// artist and every release; an artist carries its next and last album). Only
// the scalar fields, statistics, ratings, images, and genres are ever read
// back, so the embeds are dropped before persisting. Keys are removed rather
// than allow-listed so new scalar fields keep flowing through untouched.

const LIDARR_ARTIST_DROPPED_KEYS = ["nextAlbum", "lastAlbum", "members", "links", "overview"];
const LIDARR_ALBUM_DROPPED_KEYS = ["artist", "releases", "links", "overview"];
const LIDARR_TRACK_DROPPED_KEYS = ["artist", "album"];

const isPlainObject = (value) =>
  value != null && typeof value === "object" && !Array.isArray(value);

const withoutKeys = (resource, keys) => {
  if (!isPlainObject(resource)) return resource;
  const projected = { ...resource };
  for (const key of keys) delete projected[key];
  return projected;
};

export const slimLidarrArtist = (artist) => withoutKeys(artist, LIDARR_ARTIST_DROPPED_KEYS);
export const slimLidarrAlbum = (album) => withoutKeys(album, LIDARR_ALBUM_DROPPED_KEYS);
export const slimLidarrTrack = (track) => withoutKeys(track, LIDARR_TRACK_DROPPED_KEYS);

const isBinary = (value) =>
  ArrayBuffer.isView(value) || value instanceof ArrayBuffer ||
  (isPlainObject(value) && value.type === "Buffer" && Array.isArray(value.data));

// `music-metadata` common tags: embedded artwork and any other binary payloads
// are dropped; everything else is kept as tag text.
export function slimFileTags(common) {
  if (!isPlainObject(common)) return {};
  const tags = {};
  for (const [key, value] of Object.entries(common)) {
    if (key === "picture" || isBinary(value)) continue;
    if (Array.isArray(value)) {
      const items = value.filter((entry) => !isBinary(entry));
      if (items.length) tags[key] = items;
      continue;
    }
    if (value !== undefined) tags[key] = value;
  }
  return tags;
}
