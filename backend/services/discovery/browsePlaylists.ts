import { randomUUID } from "crypto";
import * as v from "valibot";
import { toQueueTracks } from "../../routes/library/handlers/queueTracks.ts";
import { playlistOperationQueue } from "../playlists/playlistOperationQueue.ts";
import { normalizePlaylistTrack } from "../playlists/playlistTracks.ts";
import { resolveLibraryTracks } from "../subsonicLibraryService.ts";
import {
  getDiscoveryPlaylist,
  getDiscoveryPlaylists,
  type CatalogTrack,
} from "./discoveryPlaylists.ts";
import {
  addEditorialPlaylistToLibrary,
  getEditorialPlaylist,
  getEditorialShelf,
  pickAvailableName,
} from "./editorialPlaylists.ts";
import { getUserMix, getUserMixes, type Mix } from "./mixes.ts";
import { BROWSE_PROVIDERS, type BrowseProvider } from "../../../lib/browsePlaylists.ts";
import type { ShelfScope } from "../importLists/deezerPlaylists.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";

export const browseProviderSchema = v.picklist(BROWSE_PROVIDERS);

const AURRAL = "Aurral";

type BrowsePlaylist = {
  provider: BrowseProvider;
  id: string;
  name: string;
  description: string | null;
  curator: string | null;
  artworkUrl: string | null;
  trackCount: number;
};

type QueueTrack = ReturnType<typeof toQueueTracks>[number];

const notFound = (message: string) =>
  Object.assign(new Error(message), { statusCode: 404, code: "PLAYLIST_NOT_FOUND" });

const fromQueueTrack = (track: QueueTrack) => ({
  artistName: track.artist,
  trackName: track.title,
  albumName: track.album,
  durationMs: track.durationMs,
  preview_url: null,
  artworkUrl: track.artworkUrl,
  deezerAlbumId: null,
  owned: track,
});

function withOwnedTracks(tracks: CatalogTrack[]) {
  const matches = resolveLibraryTracks(tracks);
  const owned = new Map(
    toQueueTracks(matches.flatMap((match) => (match ? [match.track.id] : []))).map((track) => [
      track.libraryTrackId,
      track,
    ]),
  );
  return tracks.map((track, index) => {
    const match = matches[index];
    return { ...track, owned: (match && owned.get(match.track.id)) || null };
  });
}

function mixPlaylists(mixes: Mix[]): BrowsePlaylist[] {
  const covers = new Map(
    toQueueTracks(mixes.flatMap((mix) => mix.trackIds.slice(0, 1))).map((track) => [
      track.libraryTrackId,
      track.artworkUrl,
    ]),
  );
  return mixes.map((mix) => ({
    provider: "mix",
    id: mix.id,
    name: mix.name,
    description: mix.description,
    curator: AURRAL,
    artworkUrl: covers.get(mix.trackIds[0] ?? -1) ?? null,
    trackCount: mix.trackIds.length,
  }));
}

export async function getMadeForYou(user: RequestUser) {
  const mixes = mixPlaylists(await getUserMixes(user.id));
  const discovery = getDiscoveryPlaylists(user.id).map((playlist): BrowsePlaylist => ({
    provider: "discovery",
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    curator: AURRAL,
    artworkUrl: playlist.tracks.find((track) => track.artworkUrl)?.artworkUrl ?? null,
    trackCount: playlist.tracks.length,
  }));
  return { discovery, mixes };
}

export async function getPlaylistShelf(user: RequestUser, scope?: ShelfScope) {
  const { forYou, categories } = await getEditorialShelf(user, scope);
  const deezer = (playlist: Omit<BrowsePlaylist, "provider">): BrowsePlaylist => ({
    ...playlist,
    provider: "deezer",
  });
  return {
    forYou: forYou.map(deezer),
    categories: categories.map((category) => ({
      ...category,
      playlists: category.playlists.map(deezer),
    })),
  };
}

export async function getBrowsePlaylist(user: RequestUser, provider: BrowseProvider, id: string) {
  if (provider === "deezer") {
    const playlist = await getEditorialPlaylist(user, id);
    return { ...playlist, provider, tracks: withOwnedTracks(playlist.tracks) };
  }
  if (provider === "discovery") {
    const playlist = getDiscoveryPlaylist(user.id, id);
    if (!playlist) throw notFound("This playlist isn't available anymore");
    return {
      provider,
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      curator: AURRAL,
      artworkUrl: playlist.tracks.find((track) => track.artworkUrl)?.artworkUrl ?? null,
      tracks: withOwnedTracks(playlist.tracks),
      libraryPlaylistId: null,
    };
  }
  const mix = await getUserMix(user.id, id);
  if (!mix) throw notFound("This mix isn't available anymore");
  const tracks = toQueueTracks(mix.trackIds).map(fromQueueTrack);
  return {
    provider,
    id: mix.id,
    name: mix.name,
    description: mix.description,
    curator: AURRAL,
    artworkUrl: tracks[0]?.artworkUrl ?? null,
    tracks,
    libraryPlaylistId: null,
  };
}

export async function saveBrowsePlaylist(user: RequestUser, provider: BrowseProvider, id: string) {
  if (provider === "deezer") return addEditorialPlaylistToLibrary(user, id);
  const playlist = await getBrowsePlaylist(user, provider, id);
  const name = pickAvailableName(user.id, playlist.name, AURRAL);
  const playlistId = randomUUID();
  const tracks = playlist.tracks.flatMap((track) => {
    const normalized = normalizePlaylistTrack(track);
    return normalized ? [normalized] : [];
  });
  await playlistOperationQueue.enqueuePayload({
    kind: "shared-playlist-create",
    label: "shared-playlist:create",
    playlistId,
    name,
    sourceName: AURRAL,
    description: playlist.description,
    tracks,
    ownerUserId: user.id,
    downloadMissing: provider === "discovery",
  });
  return {
    playlistId,
    name,
    alreadyAdded: false as const,
    tracksQueued:
      provider === "discovery" ? playlist.tracks.filter((track) => !track.owned).length : 0,
  };
}
