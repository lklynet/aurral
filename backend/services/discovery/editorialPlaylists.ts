import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { enqueueImportedPlaylist, type ImportedPlaylist } from "../importLists/importPlaylist.ts";
import {
  getDeezerPlaylist,
  getEditorialShelf as getCategoryShelf,
  loadEditorialSearch,
  type ShelfScope,
  validateDeezerPlaylistId,
} from "../importLists/deezerPlaylists.ts";
import { resolveArtistAndAlbumMbids } from "../apiClients/index.ts";
import { getUserDiscovery } from "./userDiscovery.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";
import type { NativeImportProvider } from "../../../lib/importProviders.ts";

const PROVIDER = "deezer-playlist";
const SYNC_INTERVAL_HOURS = 24;
const FOR_YOU_TERMS = 6;
const FOR_YOU_PER_TERM = 2;
const FOR_YOU_LIMIT = 12;
const pendingAdds = new Map<string, Promise<SyncedPlaylistAddResponse>>();

export const findLibraryPlaylist = (
  userId: number,
  externalId: string,
  provider: NativeImportProvider = PROVIDER,
) =>
  flowPlaylistConfig
    .getStaticPlaylistsOwnedByUser(userId)
    .find(
      (playlist) =>
        playlist.importSource?.provider === provider &&
        playlist.importSource.externalId === externalId,
    ) || null;

export const pickAvailableName = (userId: number, name: string, sourceName = "Deezer") => {
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
      attempt === 1
        ? name
        : attempt === 2
          ? `${name} (${sourceName})`
          : `${name} (${sourceName} ${attempt - 1})`;
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
  const results = await Promise.allSettled(terms.map(loadEditorialSearch));
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

export async function getEditorialShelf(user: RequestUser, scope?: ShelfScope) {
  const [categories, forYou] = await Promise.all([
    getCategoryShelf(scope),
    getForYouPlaylists(user.id).catch(() => []),
  ]);
  return { forYou, categories };
}

export async function resolveEditorialTrackLinks({
  artistName,
  albumName,
  deezerAlbumId,
  trackName,
}: {
  artistName: unknown;
  albumName: unknown;
  deezerAlbumId: unknown;
  trackName?: string;
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
    trackName,
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

type SyncedPlaylistSource = {
  provider: NativeImportProvider;
  externalId: string;
  sourceName: string;
  load: () => Promise<
    Pick<ImportedPlaylist, "artworkUrl" | "tracks" | "stats"> & {
      name: string;
      description: string | null;
    }
  >;
};

type SyncedPlaylistAddResponse =
  | { playlistId: string; name: string; alreadyAdded: true }
  | { playlistId: string; name: string; alreadyAdded: false; tracksQueued: number };

export function addSyncedPlaylist(user: RequestUser, source: SyncedPlaylistSource) {
  const key = `${user.id}:${source.provider}:${source.externalId}`;
  if (!pendingAdds.has(key)) {
    pendingAdds.set(
      key,
      addToLibrary(user, source).finally(() => pendingAdds.delete(key)),
    );
  }
  return pendingAdds.get(key)!;
}

export const addEditorialPlaylistToLibrary = async (user: RequestUser, value: string) => {
  const id = validateDeezerPlaylistId(value);
  return addSyncedPlaylist(user, {
    provider: PROVIDER,
    externalId: id,
    sourceName: "Deezer",
    load: () => getDeezerPlaylist(id),
  });
};

async function addToLibrary(
  user: RequestUser,
  { provider, externalId, sourceName, load }: SyncedPlaylistSource,
): Promise<SyncedPlaylistAddResponse> {
  const existing = findLibraryPlaylist(user.id, externalId, provider);
  if (existing) {
    return { playlistId: existing.id, name: existing.name, alreadyAdded: true };
  }
  const playlist = await load();
  const name = pickAvailableName(user.id, playlist.name, sourceName);
  const result = await enqueueImportedPlaylist({
    ownerUserId: user.id,
    name,
    sourceName,
    description: playlist.description,
    provider,
    externalId,
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
