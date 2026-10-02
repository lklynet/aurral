import { flowPlaylistConfig } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";
import { enqueueImportedPlaylist } from "../importLists/importPlaylist.js";
import {
  getDeezerPlaylist,
  getEditorialShelf as getGenreShelf,
  searchEditorialPlaylists,
  validateDeezerPlaylistId,
} from "../importLists/deezerPlaylists.js";
import {
  musicbrainzResolveArtistMbidByName,
  resolveDeezerAlbumToMbid,
} from "../apiClients/index.js";
import { getUserDiscovery } from "./userDiscovery.js";

const PROVIDER = "deezer-playlist";
const SYNC_INTERVAL_HOURS = 24;
const FOR_YOU_TERMS = 6;
const FOR_YOU_PER_TERM = 2;
const FOR_YOU_LIMIT = 12;

const findLibraryPlaylist = (userId, deezerPlaylistId) =>
  flowPlaylistConfig
    .getSharedPlaylistsOwnedByUser(userId)
    .find(
      (playlist) =>
        playlist.importSource?.provider === PROVIDER &&
        playlist.importSource.externalId === deezerPlaylistId,
    ) || null;

const pickAvailableName = (userId, name) => {
  const taken = new Set(
    [
      ...flowPlaylistConfig.getSharedPlaylistsOwnedByUser(userId),
      ...flowPlaylistConfig.getFlowsOwnedByUser(userId),
    ].map((entry) => String(entry?.name || "").trim().toLowerCase()),
  );
  for (let attempt = 1; ; attempt += 1) {
    const candidate =
      attempt === 1 ? name : attempt === 2 ? `${name} (Deezer)` : `${name} (Deezer ${attempt - 1})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

const uniqueTerms = (values) => {
  const seen = new Set();
  const terms = [];
  for (const value of values) {
    const term = String(value || "").trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
    if (terms.length >= FOR_YOU_TERMS) break;
  }
  return terms;
};

async function getForYouPlaylists(userId) {
  const { body } = await getUserDiscovery(userId, 0, 0);
  const terms = uniqueTerms([...(body.topGenres || []), ...(body.topTags || [])]);
  const results = await Promise.allSettled(terms.map(searchEditorialPlaylists));
  const seen = new Set();
  const playlists = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const playlist of result.value.filter((entry) => !seen.has(entry.id)).slice(0, FOR_YOU_PER_TERM)) {
      seen.add(playlist.id);
      playlists.push(playlist);
    }
  }
  return playlists.slice(0, FOR_YOU_LIMIT);
}

export async function getEditorialShelf(user) {
  const [genres, forYou] = await Promise.all([
    getGenreShelf(),
    getForYouPlaylists(user.id).catch(() => []),
  ]);
  return { forYou, genres };
}

export async function resolveEditorialTrackLinks({ artistName, albumName, deezerAlbumId }) {
  const artist = String(artistName || "").trim();
  if (!artist) {
    throw Object.assign(new Error("artistName is required"), { statusCode: 400 });
  }
  const album = String(albumName || "").trim();
  const albumId = String(deezerAlbumId || "").trim();
  const [artistMbid, albumMbid] = await Promise.all([
    musicbrainzResolveArtistMbidByName(artist),
    album && /^\d+$/.test(albumId) ? resolveDeezerAlbumToMbid(artist, album, albumId) : null,
  ]);
  return { artistMbid: artistMbid || null, albumMbid: albumMbid || null };
}

export async function getEditorialPlaylist(user, value) {
  const id = validateDeezerPlaylistId(value);
  const playlist = await getDeezerPlaylist(id);
  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    curator: playlist.curator,
    artworkUrl: playlist.artworkUrl,
    tracks: playlist.tracks,
    libraryPlaylistId: findLibraryPlaylist(user.id, id)?.id || null,
  };
}

export async function addEditorialPlaylistToLibrary(user, value) {
  const id = validateDeezerPlaylistId(value);
  const existing = findLibraryPlaylist(user.id, id);
  if (existing) {
    return { playlistId: existing.id, name: existing.name, alreadyAdded: true };
  }
  const playlist = await getDeezerPlaylist(id);
  const name = pickAvailableName(user.id, playlist.name);
  const result = await enqueueImportedPlaylist({
    ownerUserId: user.id,
    name,
    sourceName: "Deezer",
    description: playlist.description,
    provider: PROVIDER,
    externalId: id,
    externalName: playlist.name,
    tracks: playlist.tracks,
    sourceStats: playlist.stats,
    syncEnabled: true,
    syncIntervalHours: SYNC_INTERVAL_HOURS,
    keepRemovedTracks: true,
  });
  return {
    playlistId: result.playlistId,
    name,
    alreadyAdded: false,
    tracksQueued: result.tracksQueued,
  };
}
