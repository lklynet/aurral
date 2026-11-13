import * as v from "valibot";
import { db } from "../../config/db-sqlite.ts";
import { toQueueTracks } from "../queueTracks.ts";
import {
  getDiscoveryPlaylist,
  getDiscoveryPlaylists,
  type CatalogTrack,
} from "./discoveryPlaylists.ts";
import {
  addEditorialPlaylistToLibrary,
  addSyncedPlaylist,
  findLibraryPlaylist,
  getEditorialPlaylist,
  getEditorialShelf,
} from "./editorialPlaylists.ts";
import { getAurralPlaylist, importAurralPlaylist, withOwnedTracks } from "./aurralPlaylists.ts";
import { getUserMix, getUserMixes, type Mix } from "./mixes.ts";
import { browseCoverTemplate, browseCoverUrl, type BrowseCover } from "./browseCovers.ts";
import {
  BROWSE_IMPORT_PROVIDERS,
  BROWSE_PROVIDERS,
  type BrowseProvider,
} from "../../../lib/browsePlaylists.ts";
import { getDeezerArtistPlaylists, type ShelfScope } from "../importLists/deezerPlaylists.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";
import type { LibraryArtistsRow } from "../../db/rows.ts";

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

const artistStmt = db.prepare<[number], Pick<LibraryArtistsRow, "name" | "mbid">>(
  "SELECT name, mbid FROM library_artists WHERE id = ?",
);

function mixCovers(mixes: Mix[]) {
  const leads = new Map(
    toQueueTracks(mixes.flatMap((mix) => mix.trackIds.slice(0, 1))).map((track) => [
      track.libraryTrackId,
      track,
    ]),
  );
  return mixes.map((mix): BrowseCover => {
    const seed = mix.artistId ? artistStmt.get(mix.artistId) : undefined;
    const lead = leads.get(mix.trackIds[0] ?? -1);
    return {
      title: mix.name,
      template: browseCoverTemplate("mix", mix.id),
      artist: seed
        ? { artistName: seed.name, artistMbid: seed.mbid }
        : lead
          ? { artistName: lead.artist, artistMbid: lead.artistMbid }
          : null,
    };
  });
}

const discoveryCover = (playlist: { id: string; name: string; tracks: CatalogTrack[] }) => {
  const lead = playlist.tracks[0]?.artistName;
  return {
    title: playlist.name,
    template: browseCoverTemplate("discovery", playlist.id),
    artist: lead ? { artistName: lead, artistMbid: null } : null,
  } satisfies BrowseCover;
};

export async function getBrowseCover(user: RequestUser, provider: BrowseProvider, id: string) {
  if (provider === "discovery") {
    const playlist = getDiscoveryPlaylist(user.id, id);
    return playlist && discoveryCover(playlist);
  }
  if (provider === "mix") {
    const mix = await getUserMix(user.id, id);
    return mix && (mixCovers([mix])[0] ?? null);
  }
  return null;
}

export async function getMadeForYou(user: RequestUser) {
  const userMixes = await getUserMixes(user.id);
  const covers = mixCovers(userMixes);
  const mixes = userMixes.map((mix, index): BrowsePlaylist => {
    const cover = covers[index];
    return {
      provider: "mix",
      id: mix.id,
      name: mix.name,
      description: mix.description,
      curator: AURRAL,
      artworkUrl: cover ? browseCoverUrl("mix", mix.id, cover) : null,
      trackCount: mix.trackIds.length,
    };
  });
  const discovery = getDiscoveryPlaylists(user.id).map((playlist): BrowsePlaylist => ({
    provider: "discovery",
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    curator: AURRAL,
    artworkUrl: browseCoverUrl("discovery", playlist.id, discoveryCover(playlist)),
    trackCount: playlist.tracks.length,
  }));
  return { discovery, mixes };
}

const deezer = (playlist: Omit<BrowsePlaylist, "provider">): BrowsePlaylist => ({
  ...playlist,
  provider: "deezer",
});

export async function getPlaylistShelf(user: RequestUser, scope?: ShelfScope) {
  const { forYou, categories } = await getEditorialShelf(user, scope);
  return {
    forYou: forYou.map(deezer),
    categories: categories.map((category) => ({
      ...category,
      playlists: category.playlists.map(deezer),
    })),
  };
}

export const getArtistPlaylists = async (deezerArtistId: string) =>
  (await getDeezerArtistPlaylists(deezerArtistId)).map(deezer);

export async function getBrowsePlaylist(user: RequestUser, provider: BrowseProvider, id: string) {
  if (provider === "deezer") {
    const playlist = await getEditorialPlaylist(user, id);
    return { ...playlist, provider, tracks: withOwnedTracks(playlist.tracks) };
  }
  const playlist = await getAurralPlaylist(provider, user.id, id);
  const cover =
    playlist.provider === "discovery" ? discoveryCover(playlist) : mixCovers([playlist])[0];
  return {
    provider,
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    curator: AURRAL,
    artworkUrl: cover ? browseCoverUrl(provider, playlist.id, cover) : null,
    tracks: playlist.tracks,
    libraryPlaylistId:
      findLibraryPlaylist(user.id, id, BROWSE_IMPORT_PROVIDERS[provider])?.id || null,
  };
}

export async function saveBrowsePlaylist(user: RequestUser, provider: BrowseProvider, id: string) {
  if (provider === "deezer") return addEditorialPlaylistToLibrary(user, id);
  return addSyncedPlaylist(user, {
    provider: BROWSE_IMPORT_PROVIDERS[provider],
    externalId: id,
    sourceName: AURRAL,
    load: () => importAurralPlaylist(provider, user.id, id),
  });
}
