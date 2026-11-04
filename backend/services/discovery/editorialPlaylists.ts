import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { enqueueImportedPlaylist } from "../importLists/importPlaylist.ts";
import {
  getDeezerPlaylist,
  getEditorialShelf as getGenreShelf,
  searchEditorialPlaylists,
  validateDeezerPlaylistId,
} from "../importLists/deezerPlaylists.ts";
import { resolveArtistAndAlbumMbids } from "../apiClients/index.ts";
import { getUserDiscovery } from "./userDiscovery.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";

const PROVIDER = "deezer-playlist";
const SYNC_INTERVAL_HOURS = 24;
const FOR_YOU_TERMS = 6;
const FOR_YOU_PER_TERM = 2;
const FOR_YOU_LIMIT = 12;
const pendingAdds = new Map<string, Promise<EditorialLibraryAddResponse>>();

export const findLibraryPlaylist = (userId: number, deezerPlaylistId: string) =>
  flowPlaylistConfig
    .getStaticPlaylistsOwnedByUser(userId)
    .find(
      (playlist) =>
        playlist.importSource?.provider === PROVIDER &&
        playlist.importSource.externalId === deezerPlaylistId,
    ) || null;

const pickAvailableName = (userId: number, name: string) => {
  const taken = new Set(
    [
      ...flowPlaylistConfig.getStaticPlaylistsOwnedByUser(userId),
      ...flowPlaylistConfig.getFlowsOwnedByUser(userId),
    ].map((entry) =>
      String(entry?.name || "")
        .trim()
        .toLowerCase(),
    ),
  );
  for (let attempt = 1; ; attempt += 1) {
    const candidate =
      attempt === 1 ? name : attempt === 2 ? `${name} (Deezer)` : `${name} (Deezer ${attempt - 1})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

const uniqueTerms = (values: Iterable<unknown>) => {
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

async function getForYouPlaylists(userId: number) {
  const { body } = await getUserDiscovery(userId, 0, 0);
  const terms = uniqueTerms([...(body.topGenres || []), ...(body.topTags || [])]);
  const results = await Promise.allSettled(terms.map(searchEditorialPlaylists));
  const seen = new Set();
  const playlists = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const playlist of result.value
      .filter((entry) => !seen.has(entry.id))
      .slice(0, FOR_YOU_PER_TERM)) {
      seen.add(playlist.id);
      playlists.push(playlist);
    }
  }
  return playlists.slice(0, FOR_YOU_LIMIT);
}

export async function getEditorialShelf(user: RequestUser) {
  const [genres, forYou] = await Promise.all([
    getGenreShelf(),
    getForYouPlaylists(user.id).catch(() => []),
  ]);
  return { forYou, genres };
}

export async function resolveEditorialTrackLinks({
  artistName,
  albumName,
  deezerAlbumId,
}: {
  artistName: unknown;
  albumName: unknown;
  deezerAlbumId: unknown;
}) {
  const artist = String(artistName || "").trim();
  if (!artist) {
    throw Object.assign(new Error("artistName is required"), { statusCode: 400 });
  }
  const albumId = String(deezerAlbumId || "").trim();
  return resolveArtistAndAlbumMbids({
    artistName: artist,
    albumName,
    deezerAlbumId: /^\d+$/.test(albumId) ? albumId : null,
  });
}

export async function getEditorialPlaylist(user: RequestUser, value: string) {
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

type EditorialLibraryAddResponse =
  | { playlistId: string; name: string; alreadyAdded: true }
  | { playlistId: string; name: string; alreadyAdded: false; tracksQueued: number };

export async function addEditorialPlaylistToLibrary(user: RequestUser, value: string) {
  const id = validateDeezerPlaylistId(value);
  const key = `${user.id}:${id}`;
  if (!pendingAdds.has(key)) {
    pendingAdds.set(
      key,
      addToLibrary(user, id).finally(() => pendingAdds.delete(key)),
    );
  }
  return pendingAdds.get(key)!;
}

async function addToLibrary(user: RequestUser, id: string): Promise<EditorialLibraryAddResponse> {
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
    artworkUrl: playlist.artworkUrl,
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
