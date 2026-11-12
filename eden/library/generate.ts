import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";
import { CATALOGUE_ARTISTS, VARIOUS_ARTISTS_ID } from "../catalogue/artists.ts";
import {
  albumEdition,
  type Catalogue,
  type CatalogueAlbum,
  type CatalogueRelease,
  type CatalogueTrack,
} from "../catalogue/catalogue.ts";
import { generatedCover } from "./cover.ts";
import { writeSilentFlac, type CoverImage } from "./flac.ts";

const UNKNOWN_DATE = "0001-01-01";
const UNKNOWN_LENGTH_MS = 180_000;
const LIBRARY_ARTIST_EVERY = 3;
const ALBUMS_PER_ARTIST = 3;
const INCOMPLETE_ALBUM_EVERY = 7;
const WORLD_ALBUMS_PER_ARTIST = 2;

export type PlannedTrack = {
  album: CatalogueAlbum;
  release: CatalogueRelease;
  track: CatalogueTrack;
  durationMs: number;
};

const MAX_NAME_BYTES = 180;
const UNSAFE_IN_NAMES = '\\/:*?"<>|';

// File systems cap a name at 255 bytes, and some track titles run past it.
function pathPart(value: string) {
  let name = Array.from(value, (character) =>
    character < " " || UNSAFE_IN_NAMES.includes(character) ? "_" : character,
  ).join("");
  while (Buffer.byteLength(name) > MAX_NAME_BYTES) name = name.slice(0, -1);
  return name.replace(/[. ]+$/, "").trim() || "Unknown";
}

const artistNames = (album: CatalogueAlbum | undefined) =>
  new Map((album?.artists ?? []).map((artist) => [artist.id, artist.artistname]));

function trackTags({ album, release, track }: PlannedTrack) {
  const names = artistNames(album);
  const albumArtist = names.get(album.artistid ?? "") ?? "Unknown Artist";
  const discs = new Set((release.tracks ?? []).map((entry) => entry.mediumnumber ?? 1)).size;
  const date = release.releasedate || album.releasedate;
  const tags: Record<string, string | readonly string[]> = {
    TITLE: track.trackname ?? "",
    ARTIST: names.get(track.artistid ?? "") ?? albumArtist,
    ALBUMARTIST: albumArtist,
    ALBUM: album.title,
    TRACKNUMBER: String(track.trackposition ?? 0),
    DISCNUMBER: String(track.mediumnumber ?? 1),
    TOTALDISCS: String(discs),
    GENRE: album.genres ?? [],
    MUSICBRAINZ_ALBUMARTISTID: album.artistid ?? "",
    MUSICBRAINZ_ARTISTID: track.artistid || album.artistid || "",
    MUSICBRAINZ_ALBUMID: release.id,
    MUSICBRAINZ_RELEASEGROUPID: album.id,
    MUSICBRAINZ_TRACKID: track.recordingid ?? "",
    MUSICBRAINZ_RELEASETRACKID: track.id,
  };
  if (date && date !== UNKNOWN_DATE) tags.DATE = date;
  return tags;
}

export function trackFileName({ release, track }: PlannedTrack, extension: string) {
  const discs = new Set((release.tracks ?? []).map((entry) => entry.mediumnumber ?? 1)).size;
  const position = String(track.trackposition ?? 0).padStart(2, "0");
  const prefix = discs > 1 ? `${track.mediumnumber ?? 1}-${position}` : position;
  return `${prefix} - ${pathPart(track.trackname ?? "Untitled")}.${extension}`;
}

export function albumFolder(album: CatalogueAlbum) {
  const artist = artistNames(album).get(album.artistid ?? "") ?? "Unknown Artist";
  return path.join(pathPart(artist), pathPart(album.title));
}

export function planAlbum(album: CatalogueAlbum): PlannedTrack[] {
  const edition = albumEdition(album);
  if (!edition) return [];
  return edition.tracks.map((track) => ({
    album,
    release: edition.release,
    track,
    durationMs: edition.lengthOf(track) || UNKNOWN_LENGTH_MS,
  }));
}

export function writeTrack(folder: string, planned: PlannedTrack, cover: CoverImage) {
  const file = path.join(folder, trackFileName(planned, "flac"));
  writeSilentFlac(file, { durationMs: planned.durationMs, tags: trackTags(planned), cover });
  return file;
}

export function writeAlbum(folder: string, tracks: PlannedTrack[]) {
  const [first] = tracks;
  if (!first) return [];
  mkdirSync(folder, { recursive: true });
  const cover = generatedCover(first.album.id);
  return tracks.map((planned) => writeTrack(folder, planned, cover));
}

const studioAlbums = (albums: CatalogueAlbum[]) =>
  albums
    .filter((album) => album.type === "Album" && !album.secondarytypes?.length)
    .toSorted(
      (left, right) =>
        (right.rating?.Count ?? 0) - (left.rating?.Count ?? 0) || left.id.localeCompare(right.id),
    );

function albumsByArtist(catalogue: Catalogue) {
  const albumsOf = new Map<string, CatalogueAlbum[]>();
  for (const album of catalogue.albums.values()) {
    const list = albumsOf.get(album.artistid ?? "") ?? [];
    list.push(album);
    albumsOf.set(album.artistid ?? "", list);
  }
  return albumsOf;
}

// The Library holds every third catalogue artist, three albums each, plus three
// compilations. Every seventh
// album is missing its last tracks, so there is always something to find and fill.
export function planLibrary(catalogue: Catalogue) {
  const albumsOf = albumsByArtist(catalogue);
  const plan: PlannedTrack[][] = [];
  CATALOGUE_ARTISTS.forEach(([artistId], index) => {
    const compilations = artistId === VARIOUS_ARTISTS_ID;
    if (index % LIBRARY_ARTIST_EVERY !== 0 && !compilations) return;
    const albums = albumsOf.get(artistId) ?? [];
    for (const album of (compilations ? albums : studioAlbums(albums)).slice(
      0,
      ALBUMS_PER_ARTIST,
    )) {
      const tracks = planAlbum(album);
      const incomplete = plan.length % INCOMPLETE_ALBUM_EVERY === INCOMPLETE_ALBUM_EVERY - 1;
      plan.push(incomplete ? tracks.slice(0, Math.max(1, tracks.length - 3)) : tracks);
    }
  });
  return plan.filter((tracks) => tracks.length > 0);
}

export function generateLibrary(catalogue: Catalogue, root: string) {
  const plan = planLibrary(catalogue);
  for (const tracks of plan) {
    const [first] = tracks;
    if (first) writeAlbum(path.join(root, albumFolder(first.album)), tracks);
  }
  return plan;
}

export type WorldRelease = { id: string; name: string; tracks: PlannedTrack[] };

// The world is what Eden's download services can find: for every catalogue artist,
// the two best-known albums the Library does not already hold. Anything else is
// nowhere to be found, which is the case a failed search needs.
export function planWorld(catalogue: Catalogue): WorldRelease[] {
  const owned = new Set(planLibrary(catalogue).map((tracks) => tracks[0]?.album.id));
  const albumsOf = albumsByArtist(catalogue);
  const names = new Set<string>();
  return CATALOGUE_ARTISTS.flatMap(([artistId]) => {
    const albums = albumsOf.get(artistId) ?? [];
    const wanted = [...studioAlbums(albums), ...albums.toSorted((a, b) => a.id.localeCompare(b.id))]
      .filter((album, index, all) => all.indexOf(album) === index && !owned.has(album.id))
      .slice(0, WORLD_ALBUMS_PER_ARTIST);
    return wanted.flatMap((album) => {
      const tracks = planAlbum(album);
      if (tracks.length === 0) return [];
      const artist = artistNames(album).get(album.artistid ?? "") ?? "Unknown Artist";
      const year = (album.releasedate ?? "").slice(0, 4);
      const base = pathPart(
        `${artist} - ${album.title}${year && year !== "0001" ? ` (${year})` : ""} [FLAC]`,
      );
      const name = names.has(base) ? `${base} {${album.id.slice(0, 8)}}` : base;
      names.add(name);
      return [{ id: album.id, name, tracks }];
    });
  });
}

const worldManifestSchema = v.array(
  v.object({
    id: v.string(),
    name: v.string(),
    artist: v.string(),
    artistId: v.string(),
    album: v.string(),
    date: v.string(),
    files: v.array(
      v.object({ name: v.string(), size: v.number(), title: v.string(), durationMs: v.number() }),
    ),
  }),
);
export type WorldManifest = v.InferOutput<typeof worldManifestSchema>;

export const WORLD_RELEASES = "releases";
const WORLD_MANIFEST = "manifest.json";

export const readWorldManifest = (root: string) =>
  v.parse(worldManifestSchema, JSON.parse(readFileSync(path.join(root, WORLD_MANIFEST), "utf8")));

// Writes the releases and a manifest of them, which the stand-in servers index.
export function generateWorld(catalogue: Catalogue, root: string) {
  const manifest: WorldManifest = planWorld(catalogue).map(({ id, name, tracks }) => {
    const album = tracks[0]?.album;
    const files = writeAlbum(path.join(root, WORLD_RELEASES, name), tracks);
    return {
      id,
      name,
      artist: artistNames(album).get(album?.artistid ?? "") ?? "",
      artistId: album?.artistid ?? "",
      album: album?.title ?? "",
      date: album?.releasedate && album.releasedate !== UNKNOWN_DATE ? album.releasedate : "",
      files: files.map((file, index) => ({
        name: path.basename(file),
        size: statSync(file).size,
        title: tracks[index]?.track.trackname ?? "",
        durationMs: tracks[index]?.durationMs ?? 0,
      })),
    };
  });
  writeFileSync(path.join(root, WORLD_MANIFEST), JSON.stringify(manifest));
  return manifest;
}
