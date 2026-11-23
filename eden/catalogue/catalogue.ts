import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as v from "valibot";
import { selectAlbumCover } from "../../backend/services/imageRanking.ts";
import {
  albumSchema as v1AlbumSchema,
  toNormalizedAlbum,
} from "../../backend/services/providers/metadataMappers.ts";
import { selectAlbumRelease } from "../../backend/services/providers/metadataRanking.ts";

const text = v.nullish(v.string());
const count = v.nullish(v.number());
const list = <Item extends v.GenericSchema>(item: Item) => v.nullish(v.array(item));

const albumRefSchema = v.looseObject({
  Id: v.string(),
  Title: text,
  Type: text,
  SecondaryTypes: list(v.string()),
  ReleaseStatuses: list(v.string()),
});

const ratingSchema = v.nullish(v.looseObject({ Count: count, Value: count }));

const imageSchema = v.looseObject({ CoverType: text, Url: text });

export const artistSchema = v.looseObject({
  id: v.string(),
  artistname: v.string(),
  sortname: text,
  disambiguation: text,
  type: text,
  overview: text,
  artistaliases: list(v.string()),
  genres: list(v.string()),
  images: list(imageSchema),
  links: list(v.looseObject({ type: text, target: text })),
  rating: ratingSchema,
  Albums: list(albumRefSchema),
});

const trackSchema = v.looseObject({
  id: v.string(),
  recordingid: text,
  trackname: text,
  tracknumber: text,
  trackposition: count,
  mediumnumber: count,
  durationms: count,
  artistid: text,
  oldids: list(v.string()),
  oldrecordingids: list(v.string()),
});

const releaseSchema = v.looseObject({
  id: v.string(),
  title: text,
  status: text,
  releasedate: text,
  disambiguation: text,
  track_count: count,
  country: list(v.string()),
  label: list(v.string()),
  media: list(v.looseObject({ Format: text, Name: text, Position: count })),
  tracks: list(trackSchema),
});

export const albumSchema = v.looseObject({
  id: v.string(),
  title: v.string(),
  artistid: text,
  type: text,
  secondarytypes: list(v.string()),
  releasedate: text,
  disambiguation: text,
  overview: text,
  genres: list(v.string()),
  images: list(imageSchema),
  rating: ratingSchema,
  artists: list(artistSchema),
  releases: list(releaseSchema),
});

export type CatalogueArtist = v.InferOutput<typeof artistSchema>;
export type CatalogueAlbum = v.InferOutput<typeof albumSchema>;
export type CatalogueRelease = v.InferOutput<typeof releaseSchema>;
export type CatalogueTrack = v.InferOutput<typeof trackSchema>;

export const CATALOGUE_DIR = path.join(import.meta.dirname, "data");

export const catalogueFile = (artistId: string) => path.join(CATALOGUE_DIR, `${artistId}.jsonl.gz`);

export function serializeArtist(artist: CatalogueArtist, albums: CatalogueAlbum[]) {
  return gzipSync([artist, ...albums].map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
    level: 9,
  });
}

export function loadCatalogue(directory = CATALOGUE_DIR) {
  const artists = new Map<string, CatalogueArtist>();
  const albums = new Map<string, CatalogueAlbum>();
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".jsonl.gz")) continue;
    const [first, ...rest] = gunzipSync(readFileSync(path.join(directory, name)))
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    if (!first) continue;
    const artist = v.parse(artistSchema, JSON.parse(first));
    artists.set(artist.id, artist);
    for (const line of rest) {
      const album = v.parse(albumSchema, JSON.parse(line));
      albums.set(album.id, album);
    }
  }
  return { artists, albums };
}

export type Catalogue = ReturnType<typeof loadCatalogue>;

export const toV1Images = (images: CatalogueArtist["images"]) =>
  (images ?? []).flatMap((image) => {
    const url = image.Url?.trim();
    return url ? [{ kind: image.CoverType?.trim() || "Cover", url }] : [];
  });

export const toV1Links = (links: CatalogueArtist["links"]) =>
  (links ?? []).flatMap((link) => {
    const target = link.target?.trim();
    return target ? [{ type: link.type?.trim() || "external", target }] : [];
  });

export const toV1Rating = (rating: CatalogueArtist["rating"]) =>
  rating?.Value != null ? { count: rating.Count ?? 0, value: rating.Value } : null;

export function shownListeners(rating: CatalogueArtist["rating"]) {
  const listeners = (rating?.Count ?? 0) * 300;
  if (listeners < 10) return listeners;
  const magnitude = 10 ** Math.floor(Math.log10(listeners));
  return Math.floor(listeners / magnitude) * magnitude;
}

export function toV1Album(album: CatalogueAlbum, catalogue?: Catalogue) {
  const images = toV1Images(album.images);
  const albumArtistId = album.artistid ?? album.artists?.[0]?.id ?? null;
  const listeners = shownListeners(album.rating);
  return {
    id: album.id,
    title: album.title,
    artistId: albumArtistId,
    artists: (album.artists ?? []).map((artist) => ({
      id: artist.id,
      name: artist.artistname,
      sortName: artist.sortname ?? artist.artistname,
      aliases: artist.artistaliases ?? [],
      disambiguation: artist.disambiguation ?? "",
      links: toV1Links(artist.links),
    })),
    type: album.type ?? "Album",
    secondaryTypes: album.secondarytypes ?? [],
    releaseDate: album.releasedate ?? null,
    disambiguation: album.disambiguation ?? "",
    genres: album.genres ?? [],
    aliases: [],
    overview: album.overview ?? "",
    images,
    cover: selectAlbumCover(images)?.url ?? null,
    links: [],
    releases: (album.releases ?? []).map((release) => ({
      id: release.id,
      title: release.title ?? "",
      status: release.status ?? null,
      country: release.country ?? [],
      label: release.label ?? [],
      media: (release.media ?? []).map((medium) => ({
        format: medium.Format ?? "",
        name: medium.Name ?? "",
        position: medium.Position ?? null,
      })),
      trackCount: release.track_count ?? null,
      tracks: (release.tracks ?? []).map((track) => {
        const credited =
          track.artistid && track.artistid !== albumArtistId
            ? catalogue?.artists.get(track.artistid)
            : undefined;
        return {
          id: track.id,
          recordingId: track.recordingid ?? "",
          oldRecordingIds: track.oldrecordingids ?? [],
          title: track.trackname ?? "",
          trackNumber: track.trackposition ?? null,
          trackPosition: track.trackposition ?? null,
          mediumNumber: track.mediumnumber ?? null,
          durationMs: track.durationms ?? null,
          artistId: track.artistid ?? null,
          ...(listeners > 0 &&
            (track.mediumnumber ?? 1) === 1 &&
            (track.trackposition === 5 || track.trackposition === 10) && { popular: true }),
          ...(credited && {
            credits: [{ id: credited.id, name: credited.artistname, joinPhrase: "" }],
          }),
        };
      }),
      releaseDate: release.releasedate ?? null,
      disambiguation: release.disambiguation ?? "",
    })),
    rating: toV1Rating(album.rating),
    listeners,
  };
}

// The edition Aurral takes an album to be, with the length it expects of each track.
// Eden's files have to be that edition, or Aurral rejects them as the wrong album.
export function albumEdition(album: CatalogueAlbum) {
  const chosen = selectAlbumRelease(toNormalizedAlbum(v.parse(v1AlbumSchema, toV1Album(album))));
  const release = album.releases?.find((entry) => entry.id === chosen?.id);
  if (!chosen || !release) return undefined;
  const lengths = new Map(chosen.tracks.map((track) => [track.id, track.durationMs ?? 0]));
  return {
    release,
    tracks: release.tracks ?? [],
    lengthOf: (track: CatalogueTrack) => lengths.get(track.id) ?? 0,
  };
}
