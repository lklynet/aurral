import { getLinkedDeezerArtistId } from "../../backend/services/providers/brainzmashMappers.ts";
import { CATALOGUE_ARTISTS, VARIOUS_ARTISTS_ID } from "../catalogue/artists.ts";
import { albumEdition, type Catalogue, type CatalogueArtist } from "../catalogue/catalogue.ts";
import { searchKey } from "../metadata/search.ts";

// The catalogue as the outside services see it: every artist, album, and track with
// a stable number, because Deezer and Ticketmaster name things by number. An artist's
// number is the Deezer ID its MusicBrainz links give, so Aurral's linked lookups land.

export type Artist = {
  number: number;
  id: string;
  name: string;
  genres: string[];
  votes: number;
  albums: Album[];
};
export type Album = {
  number: number;
  id: string;
  title: string;
  type: string;
  date: string;
  freshDays: number | null;
  cover: string | null;
  votes: number;
  artist: Artist;
  tracks: Track[];
};
export type Track = {
  number: number;
  id: string;
  title: string;
  durationMs: number;
  position: number;
  disc: number;
  key: string;
  album: Album;
  artist: Artist;
};

const ALBUM_SLOTS = 100;
const TRACK_SLOTS = 1000;
const UNLINKED_ARTIST_BASE = 10_000_000_000;
const FRESH_RELEASE_EVERY = 16;
const DAY_MS = 86_400_000;

// A fresh album came out a few days ago, whatever its recorded date.
export const releaseDate = (album: Album, now = Date.now()) =>
  album.freshDays === null
    ? album.date
    : new Date(now - album.freshDays * DAY_MS).toISOString().slice(0, 10);

export function indexMusic(catalogue: Catalogue) {
  const numbers = new Set<number>();
  const numberOf = (links: CatalogueArtist["links"], index: number) => {
    const linked = Number(
      getLinkedDeezerArtistId(links?.flatMap(({ target }) => (target ? [{ target }] : []))),
    );
    const number = linked && !numbers.has(linked) ? linked : UNLINKED_ARTIST_BASE + index;
    numbers.add(number);
    return number;
  };
  const artists: Artist[] = CATALOGUE_ARTISTS.flatMap(([id], index) => {
    const artist = catalogue.artists.get(id);
    if (!artist || id === VARIOUS_ARTISTS_ID) return [];
    return [
      {
        number: numberOf(artist.links, index),
        id,
        name: artist.artistname,
        genres: artist.genres ?? [],
        votes: artist.rating?.Count ?? 0,
        albums: [],
      },
    ];
  });
  const artistById = new Map(artists.map((artist) => [artist.id, artist]));
  const albums = [...catalogue.albums.values()].toSorted(
    (left, right) =>
      (right.rating?.Count ?? 0) - (left.rating?.Count ?? 0) || left.id.localeCompare(right.id),
  );
  for (const album of albums) {
    const artist = artistById.get(album.artistid ?? "");
    if (!artist || artist.albums.length >= ALBUM_SLOTS) continue;
    const entry: Album = {
      number: artist.number * ALBUM_SLOTS + artist.albums.length,
      id: album.id,
      title: album.title,
      type: album.type ?? "Album",
      date: album.releasedate ?? "",
      freshDays: null,
      cover: album.images?.find((image) => image.CoverType === "Cover")?.Url ?? null,
      votes: album.rating?.Count ?? 0,
      artist,
      tracks: [],
    };
    const edition = albumEdition(album);
    entry.tracks = (edition?.tracks ?? []).slice(0, TRACK_SLOTS).map((track, index) => ({
      number: entry.number * TRACK_SLOTS + index,
      id: track.recordingid ?? track.id,
      title: track.trackname ?? "",
      durationMs: edition?.lengthOf(track) ?? 0,
      position: track.trackposition ?? index + 1,
      disc: track.mediumnumber ?? 1,
      key: searchKey(`${artist.name} ${track.trackname} ${album.title}`),
      album: entry,
      artist,
    }));
    artist.albums.push(entry);
  }
  const releaseCredits = new Map<string, { recording: string; id: string; name: string }[]>();
  for (const album of catalogue.albums.values()) {
    for (const release of album.releases ?? []) {
      releaseCredits.set(
        release.id,
        (release.tracks ?? []).flatMap((track) => {
          const credited = catalogue.artists.get(track.artistid ?? album.artistid ?? "");
          return credited && track.recordingid
            ? [{ recording: track.recordingid, id: credited.id, name: credited.artistname }]
            : [];
        }),
      );
    }
  }
  // One artist in sixteen has just put out its least-known album.
  const fresh = artists
    .filter((_, index) => index % FRESH_RELEASE_EVERY === 1)
    .flatMap((artist) => artist.albums.at(-1) ?? []);
  fresh.forEach((album, index) => {
    album.freshDays = (index + 1) * 2;
  });
  const allAlbums = artists.flatMap((artist) => artist.albums);
  const allTracks = allAlbums.flatMap((album) => album.tracks);
  const popular = artists.toSorted((left, right) => right.votes - left.votes);
  const words = (query: string | null) => searchKey(query).split(" ").filter(Boolean);

  return {
    artists,
    popular,
    fresh,
    albums: allAlbums,
    artistById,
    artistByNumber: new Map(artists.map((artist) => [artist.number, artist])),
    artistByName: new Map(artists.map((artist) => [searchKey(artist.name), artist])),
    albumById: new Map(allAlbums.map((album) => [album.id, album])),
    albumByNumber: new Map(allAlbums.map((album) => [album.number, album])),
    trackByNumber: new Map(allTracks.map((track) => [track.number, track])),
    releaseCredits,
    // One well-known track per album, best-known albums first.
    hits: popular.flatMap((artist) =>
      artist.albums.slice(0, 2).flatMap((album) => album.tracks[0] ?? []),
    ),
    genres: [...new Set(popular.flatMap((artist) => artist.genres))],
    findArtists(query: string | null) {
      const wanted = words(query);
      if (wanted.length === 0) return [];
      return popular.filter((artist) => {
        const key = searchKey(artist.name);
        return wanted.every((word) => key.includes(word));
      });
    },
    findTracks(query: string | null) {
      const wanted = words(query);
      if (wanted.length === 0) return [];
      return allTracks.filter((track) => wanted.every((word) => track.key.includes(word)));
    },
    inGenre: (genre: string | null) => {
      const key = searchKey(genre);
      return popular.filter((artist) => artist.genres.some((entry) => searchKey(entry) === key));
    },
    // Artists sharing the most genres, which is as close to "similar" as the catalogue knows.
    related(artist: Artist) {
      const shared = (other: Artist) =>
        other.genres.filter((genre) => artist.genres.includes(genre)).length;
      return popular
        .filter((other) => other !== artist && shared(other) > 0)
        .toSorted((left, right) => shared(right) - shared(left))
        .slice(0, 20);
    },
  };
}

export type Music = ReturnType<typeof indexMusic>;

export type OutsideRequest = { url: URL; method: string; body: string };

// Answers one outside service's requests with JSON. `undefined` means the stand-in
// has no answer for that request, which the proxy reports as a 404.
export type Outside = {
  hosts: readonly string[];
  respond(request: OutsideRequest, music: Music): unknown;
};

export const pageOf = <Item>(items: Item[], url: URL, sizeParam: string, startParam: string) => {
  const size = Number.parseInt(url.searchParams.get(sizeParam) ?? "", 10) || 25;
  const start = Number.parseInt(url.searchParams.get(startParam) ?? "", 10) || 0;
  return items.slice(start, start + size);
};
