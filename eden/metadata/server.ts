import { createServer, type ServerResponse } from "node:http";
import { selectAlbumCover, selectBestArtistImage } from "../../backend/services/imageRanking.ts";
import { genreSlug } from "../../backend/services/providers/metadataMappers.ts";
import {
  loadCatalogue,
  toV1Album,
  toV1Images,
  toV1Links,
  toV1Rating,
  type CatalogueAlbum,
  type CatalogueArtist,
  shownListeners,
} from "../catalogue/catalogue.ts";
import { indexMusic, releaseDate, type Music } from "../outside/music.ts";
import {
  searchAlbums,
  searchArtists,
  searchV1Albums,
  searchV1Artists,
  searchV1Tracks,
} from "./search.ts";

const catalogue = loadCatalogue();
const music = indexMusic(catalogue);
const fresh = new Map(music.fresh.map((album) => [album.id, album]));

function linkedIds(key: string) {
  const [kind, value = ""] = key.split(":");
  if (kind === "isrc") {
    const track = music.trackByNumber.get(Number.parseInt(value.slice(2), 36));
    return track
      ? [{ recordingId: track.id, albumId: track.album.id, artistId: track.artist.id }]
      : [];
  }
  if (kind === "deezer-album") {
    const album = music.albumByNumber.get(Number(value));
    return album ? [{ recordingId: null, albumId: album.id, artistId: album.artist.id }] : [];
  }
  const artist = kind === "deezer-artist" ? music.artistByNumber.get(Number(value)) : null;
  return artist ? [{ recordingId: null, albumId: null, artistId: artist.id }] : [];
}

const withFreshDate = (album: CatalogueAlbum) => {
  const entry = fresh.get(album.id);
  if (!entry) return album;
  const date = releaseDate(entry);
  return {
    ...album,
    releasedate: date,
    releases: album.releases?.map((release) => ({ ...release, releasedate: date })),
  };
};

function buildAppearsOn(catalogueData: typeof catalogue, indexed: Music) {
  const byArtist = new Map<string, Map<string, CatalogueAlbum>>();
  for (const album of catalogueData.albums.values()) {
    const ownerIds = new Set(
      [album.artistid, ...(album.artists ?? []).map((a) => a.id)].filter(Boolean),
    );
    for (const release of album.releases ?? []) {
      for (const track of release.tracks ?? []) {
        const artistId = track.artistid ?? "";
        if (!artistId || ownerIds.has(artistId) || !catalogueData.artists.has(artistId)) continue;
        let seen = byArtist.get(artistId);
        if (!seen) {
          seen = new Map();
          byArtist.set(artistId, seen);
        }
        if (!seen.has(album.id)) seen.set(album.id, album);
      }
    }
  }
  const result = new Map<string, Record<string, unknown>[]>();
  for (const [artistId, albums] of byArtist) {
    result.set(
      artistId,
      [...albums.values()].map((raw) => {
        const album = withFreshDate(raw);
        const owner = catalogueData.artists.get(album.artistid ?? "");
        const indexedAlbum = indexed.albumById.get(album.id);
        const images = toV1Images(album.images);
        return {
          id: album.id,
          title: album.title,
          type: album.type ?? "Album",
          secondaryTypes: album.secondarytypes ?? [],
          releaseStatuses: [
            ...new Set((album.releases ?? []).map((r) => r.status).filter(Boolean)),
          ],
          firstReleaseDate: album.releasedate ?? null,
          rating: toV1Rating(album.rating),
          cover: selectAlbumCover(images)?.url ?? null,
          trackCount: indexedAlbum?.tracks.length ?? album.releases?.[0]?.track_count ?? null,
          listeners: shownListeners(album.rating),
          artistId: owner?.id ?? album.artistid ?? null,
          artistName: owner?.artistname ?? "",
        };
      }),
    );
  }
  return result;
}

const appearsOnByArtist = buildAppearsOn(catalogue, music);

function artistBestImage(artist: CatalogueArtist | undefined) {
  if (!artist) return null;
  return selectBestArtistImage(toV1Images(artist.images))?.url ?? null;
}

function buildV1Artist(artist: CatalogueArtist) {
  const indexed = music.artistById.get(artist.id);
  const albums = (artist.Albums ?? []).map((ref) => {
    const rawAlbum = catalogue.albums.get(ref.Id);
    const album = rawAlbum ? withFreshDate(rawAlbum) : null;
    const indexedAlbum = music.albumById.get(ref.Id);
    const images = toV1Images(album?.images);
    return {
      id: ref.Id,
      title: album?.title ?? ref.Title ?? "",
      type: album?.type ?? ref.Type ?? "Album",
      secondaryTypes: album?.secondarytypes ?? ref.SecondaryTypes ?? [],
      releaseStatuses: ref.ReleaseStatuses ?? [],
      firstReleaseDate: album?.releasedate ?? null,
      rating: toV1Rating(album?.rating),
      cover: selectAlbumCover(images)?.url ?? null,
      trackCount: indexedAlbum?.tracks.length ?? album?.releases?.[0]?.track_count ?? null,
      listeners: shownListeners(album?.rating),
    };
  });
  const topTracks = (indexed?.albums ?? [])
    .flatMap((album) =>
      album.tracks.slice(0, 3).map((track, index) => ({
        recordingId: track.id,
        title: track.title,
        albumId: album.id,
        durationMs: track.durationMs || null,
        listeners: Math.max(100, (album.votes + 1) * 200 - index * 20),
      })),
    )
    .slice(0, 20);
  const similar = (indexed ? music.related(indexed) : []).map((entry, index) => ({
    id: entry.id,
    name: entry.name,
    score: Number((1.5 - index * 0.12).toFixed(4)),
    image: artistBestImage(catalogue.artists.get(entry.id)),
    genres: catalogue.artists.get(entry.id)?.genres ?? [],
  }));
  return {
    id: artist.id,
    name: artist.artistname,
    sortName: artist.sortname ?? artist.artistname,
    type: artist.type ?? null,
    status: "active",
    disambiguation: artist.disambiguation ?? "",
    overview: artist.overview ?? "",
    genres: artist.genres ?? [],
    aliases: artist.artistaliases ?? [],
    images: toV1Images(artist.images),
    links: toV1Links(artist.links),
    rating: toV1Rating(artist.rating),
    listeners: shownListeners(artist.rating),
    albums,
    appearsOn: appearsOnByArtist.get(artist.id) ?? [],
    topTracks,
    similar,
  };
}

function buildGenres() {
  const bySlug = new Map<
    string,
    {
      name: string;
      artists: { id: string; name: string; image: string | null; listeners: number }[];
    }
  >();
  for (const name of music.genres) {
    const key = genreSlug(name);
    if (!key || bySlug.has(key)) continue;
    const members = music
      .inGenre(name)
      .slice(0, 200)
      .map((artist) => ({
        id: artist.id,
        name: artist.name,
        image: artistBestImage(catalogue.artists.get(artist.id)),
        listeners: artist.votes * 300,
      }));
    bySlug.set(key, { name, artists: members });
  }
  const index = [...bySlug.entries()]
    .map(([key, genre]) => ({ key, name: genre.name, artists: genre.artists.length }))
    .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
  return { bySlug, index };
}

const genres = buildGenres();
const port = Number(process.env.PORT || 5002);

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

const limitOf = (params: URLSearchParams, fallback: number) => {
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : fallback;
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://eden");
  const [, kind, id] = /^\/v1\/(artist|album)\/([0-9a-f-]{36})$/.exec(url.pathname) ?? [];
  if (kind === "artist" && id) {
    const artist = catalogue.artists.get(id);
    if (artist) return send(response, 200, buildV1Artist(artist));
    console.log(`not in the Eden catalogue: artist ${id}`);
    return send(response, 404, { error: "Not in the Eden catalogue" });
  }
  if (kind === "album" && id) {
    const album = catalogue.albums.get(id);
    if (album) return send(response, 200, toV1Album(withFreshDate(album), catalogue));
    console.log(`not in the Eden catalogue: album ${id}`);
    return send(response, 404, { error: "Not in the Eden catalogue" });
  }
  if (url.pathname === "/v1/genres") {
    return send(response, 200, { genres: genres.index });
  }
  if (url.pathname === "/v1/ids") {
    const keys = (url.searchParams.get("keys") ?? "").split(",");
    return send(response, 200, {
      ids: Object.fromEntries(keys.flatMap((key) => linkedIds(key).map((ids) => [key, ids]))),
    });
  }
  if (url.pathname === "/v1/fresh-releases") {
    return send(response, 200, {
      releases: music.fresh.map((album) => ({
        id: album.id,
        title: album.title,
        type: album.type,
        secondaryTypes: [],
        releaseDate: releaseDate(album),
        cover: null,
        artistIds: [album.artist.id],
        artistName: album.artist.name,
      })),
    });
  }
  const [, rawSlug] = /^\/v1\/genre\/([^/]+)$/.exec(url.pathname) ?? [];
  if (rawSlug) {
    const genre = genres.bySlug.get(decodeURIComponent(rawSlug));
    return genre ? send(response, 200, genre) : send(response, 404, { error: "Genre not found" });
  }

  const [, legacyKind, legacyId] = /^.*\/(artist|album)\/([0-9a-f-]{36})$/.exec(url.pathname) ?? [];
  if (legacyKind && legacyId) {
    const album = legacyKind === "album" ? catalogue.albums.get(legacyId) : undefined;
    const entity =
      legacyKind === "artist" ? catalogue.artists.get(legacyId) : album && withFreshDate(album);
    if (entity) return send(response, 200, entity);
    console.log(`not in the Eden catalogue: ${legacyKind} ${legacyId}`);
    return send(response, 404, { error: "Not in the Eden catalogue" });
  }

  const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
  if (url.pathname === "/v1/search") {
    const limit = limitOf(url.searchParams, 24);
    return send(response, 200, {
      artists: searchV1Artists(catalogue, query, limit),
      albums: searchV1Albums(catalogue, query, "", limit),
      tracks: searchV1Tracks(catalogue, query, "", limit),
    });
  }
  if (url.pathname === "/v1/search/artist") {
    return send(response, 200, {
      artists: searchV1Artists(catalogue, query, limitOf(url.searchParams, 24)),
    });
  }
  if (url.pathname === "/v1/search/album") {
    const artist = url.searchParams.get("artist") ?? "";
    return send(response, 200, {
      albums: searchV1Albums(catalogue, query, artist, limitOf(url.searchParams, 24)),
    });
  }
  if (url.pathname === "/v1/search/track") {
    const artist = url.searchParams.get("artist") ?? "";
    return send(response, 200, {
      tracks: searchV1Tracks(catalogue, query, artist, limitOf(url.searchParams, 24)),
    });
  }
  if (url.pathname.endsWith("/search/artist")) {
    return send(response, 200, searchArtists(catalogue, query, limitOf(url.searchParams, 24)));
  }
  if (url.pathname.endsWith("/search/album")) {
    const artist = url.searchParams.get("artist") ?? "";
    return send(
      response,
      200,
      searchAlbums(catalogue, query, artist, limitOf(url.searchParams, 24)),
    );
  }
  if (url.pathname === "/health") {
    return send(response, 200, { artists: catalogue.artists.size, albums: catalogue.albums.size });
  }
  send(response, 404, { error: "Unknown path" });
}).listen(port, () => {
  console.log(
    `Eden metadata: ${catalogue.artists.size} artists, ${catalogue.albums.size} albums on :${port}`,
  );
});
