import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import {
  CATALOGUE_INDEX,
  catalogueFile,
  serializeArtist,
  type CatalogueAlbum,
  type CatalogueArtist,
  type CatalogueIndex,
} from "../../catalogue/catalogue.ts";
import { SHOWROOM_PICKS, type Pick } from "./picks.ts";
import { SHOWROOM_CATALOGUE } from "./scene.ts";

// Records the showroom catalogue from Deezer's public API, once, by hand:
// `node eden/scenes/showroom/record.ts`. Deezer is not MusicBrainz, so this never
// reaches the shared relay. IDs are made from Deezer's, so a re-record keeps them.

const REQUEST_INTERVAL_MS = 150;
const DISCOVERED_ALBUMS = 2;
const PLAYLIST_TRACKS = 60;
const PLAYLISTS = [
  "90s Pop Rock",
  "Everyday is Halloween",
  "2000s Rock",
  "90s Rock",
  "Pop Punk Essentials",
  "Emo Essentials",
  "2010s Rock",
  "Hot New Rock",
  "Indie Sleaze",
];

const deezerArtist = v.looseObject({
  id: v.number(),
  name: v.string(),
  picture_xl: v.nullish(v.string()),
  nb_fan: v.nullish(v.number()),
});
const deezerAlbumHit = v.looseObject({
  id: v.number(),
  title: v.string(),
  record_type: v.nullish(v.string()),
  artist: v.optional(v.looseObject({ id: v.number(), name: v.string() })),
});
const deezerAlbum = v.looseObject({
  id: v.number(),
  title: v.string(),
  cover_xl: v.nullish(v.string()),
  release_date: v.nullish(v.string()),
  record_type: v.nullish(v.string()),
  label: v.nullish(v.string()),
  fans: v.nullish(v.number()),
});
const deezerTrack = v.looseObject({
  id: v.number(),
  title: v.string(),
  duration: v.number(),
  track_position: v.number(),
  disk_number: v.number(),
});
const deezerPlaylist = v.looseObject({
  id: v.number(),
  title: v.string(),
  picture_xl: v.nullish(v.string()),
  nb_tracks: v.number(),
  user: v.nullish(v.looseObject({ name: v.string() })),
});
const playlistTrack = v.looseObject({
  title: v.string(),
  artist: v.looseObject({ name: v.string() }),
});
const listOf = <Item extends v.GenericSchema>(item: Item) => v.looseObject({ data: v.array(item) });

let lastRequest = 0;
async function deezer(pathname: string, params: Record<string, string> = {}): Promise<unknown> {
  await delay(Math.max(0, lastRequest + REQUEST_INTERVAL_MS - Date.now()));
  lastRequest = Date.now();
  const url = new URL(pathname, "https://api.deezer.com");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const body: unknown = await response.json();
  return body;
}

function uuid(key: string) {
  const hex = createHash("sha1").update(`eden-showroom:${key}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const plain = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

type AlbumHit = v.InferOutput<typeof deezerAlbumHit>;

const ALTERED = /\b(live|remix|remixes|reimagined|lp\d)\b/i;

const exactly = (hits: AlbumHit[], title: string) =>
  hits.find((hit) => hit.title.toLowerCase() === title.toLowerCase()) ??
  hits.find((hit) => plain(hit.title) === plain(title) && !ALTERED.test(hit.title));

const loosely = (hits: AlbumHit[], title: string) =>
  exactly(hits, title) ??
  hits.find((hit) => plain(hit.title) === plain(title)) ??
  hits.find((hit) => plain(hit.title).startsWith(plain(title)));

async function findAlbum(pick: Pick, title: string) {
  const { data } = v.parse(
    listOf(deezerAlbumHit),
    await deezer("/search/album", { q: `artist:"${pick.name}" album:"${title}"`, limit: "25" }),
  );
  const byArtist = data.filter((hit) => plain(hit.artist?.name ?? "") === plain(pick.name));
  const artistId = byArtist[0]?.artist?.id ?? (await findArtist(pick.name));
  const found = exactly(byArtist, title) ?? loosely(await albumsOf(artistId), title);
  if (!found) console.warn(`Deezer has no "${title}" by ${pick.name}`);
  return found && { albumId: found.id, artistId };
}

async function albumsOf(artistId: number) {
  const { data } = v.parse(
    listOf(deezerAlbumHit),
    await deezer(`/artist/${artistId}/albums`, { limit: "100" }),
  );
  return data;
}

async function findArtist(name: string) {
  const { data } = v.parse(listOf(deezerArtist), await deezer("/search/artist", { q: name }));
  const found =
    data
      .filter((hit) => plain(hit.name) === plain(name))
      .toSorted((left, right) => (right.nb_fan ?? 0) - (left.nb_fan ?? 0))[0] ?? data[0];
  if (!found) throw new Error(`Deezer has no artist ${name}`);
  return found.id;
}

const RECORD_TYPES: Record<string, string> = { album: "Album", ep: "EP", single: "Single" };

async function recordAlbum(albumId: number, artist: CatalogueArtist): Promise<CatalogueAlbum> {
  const album = v.parse(deezerAlbum, await deezer(`/album/${albumId}`));
  const { data: tracks } = v.parse(
    listOf(deezerTrack),
    await deezer(`/album/${albumId}/tracks`, { limit: "200" }),
  );
  const date = album.release_date ?? "";
  const discs = [...new Set(tracks.map((track) => track.disk_number))];
  return {
    id: uuid(`album:${album.id}`),
    title: album.title,
    artistid: artist.id,
    type: RECORD_TYPES[album.record_type ?? ""] ?? "Album",
    secondarytypes: [],
    releasedate: date,
    disambiguation: "",
    overview: "",
    genres: artist.genres,
    images: album.cover_xl ? [{ CoverType: "Cover", Url: album.cover_xl }] : [],
    rating: { Count: Math.round((album.fans ?? 0) / 100), Value: null },
    artists: [{ ...artist, Albums: [] }],
    releases: [
      {
        id: uuid(`release:${album.id}`),
        title: album.title,
        status: "Official",
        releasedate: date,
        disambiguation: "",
        track_count: tracks.length,
        country: ["United States"],
        label: album.label ? [album.label] : [],
        media: discs.map((disc) => ({ Format: "Digital Media", Name: "", Position: disc })),
        tracks: tracks.map((track) => ({
          id: uuid(`track:${track.id}`),
          recordingid: uuid(`recording:${track.id}`),
          trackname: track.title,
          tracknumber: String(track.track_position),
          trackposition: track.track_position,
          mediumnumber: track.disk_number,
          durationms: track.duration * 1000,
          artistid: artist.id,
          oldids: [],
          oldrecordingids: [],
        })),
      },
    ],
  };
}

type Recorded = { artist: string; library: string[] };

function copyFromLab(id: string): Recorded {
  const file = readFileSync(catalogueFile(id));
  writeFileSync(path.join(SHOWROOM_CATALOGUE, path.basename(catalogueFile(id))), file);
  return { artist: id, library: [] };
}

async function recordPick(pick: Pick): Promise<Recorded> {
  if (pick.lab) return copyFromLab(pick.lab);
  const hits: { albumId: number; artistId: number; owned: boolean }[] = [];
  for (const [owned, titles] of [
    [true, pick.owned ?? []],
    [false, pick.albums ?? []],
  ] as const) {
    for (const title of titles) {
      const hit = await findAlbum(pick, title);
      if (hit) hits.push({ ...hit, owned });
    }
  }
  const deezerId = hits[0]?.artistId ?? (await findArtist(pick.name));
  const found = v.parse(deezerArtist, await deezer(`/artist/${deezerId}`));
  if (hits.length === 0) {
    hits.push(
      ...(await albumsOf(deezerId))
        .filter((hit) => hit.record_type === "album")
        .slice(0, DISCOVERED_ALBUMS)
        .map((hit) => ({ albumId: hit.id, artistId: deezerId, owned: false })),
    );
  }
  const artist: CatalogueArtist = {
    id: uuid(`artist:${found.id}`),
    artistname: found.name,
    sortname: found.name,
    disambiguation: "",
    type: "Group",
    overview: `${found.name} is a real artist in Eden's showroom.`,
    artistaliases: [],
    genres: pick.genres,
    images: found.picture_xl ? [{ CoverType: "Poster", Url: found.picture_xl }] : [],
    links: [{ type: "deezer", target: `https://www.deezer.com/artist/${found.id}` }],
    rating: { Count: Math.round((found.nb_fan ?? 0) / 1000), Value: null },
    Albums: [],
  };
  const albums = [];
  for (const hit of hits) albums.push(await recordAlbum(hit.albumId, artist));
  const listed = albums.map((album) => ({
    Id: album.id,
    Title: album.title,
    Type: album.type,
    SecondaryTypes: [],
    ReleaseStatuses: ["Official"],
  }));
  writeFileSync(
    path.join(SHOWROOM_CATALOGUE, `${artist.id}.jsonl.gz`),
    serializeArtist({ ...artist, Albums: listed }, albums),
  );
  console.log(`${found.name}: ${albums.map((album) => album.title).join(", ")}`);
  return {
    artist: artist.id,
    library: albums.filter((_, index) => hits[index]?.owned).map((album) => album.id),
  };
}

async function recordPlaylist(title: string): Promise<CatalogueIndex["playlists"][number]> {
  const { data } = v.parse(listOf(deezerPlaylist), await deezer("/search/playlist", { q: title }));
  const found =
    data.find((hit) => plain(hit.title) === plain(title) && hit.user?.name === "Deezer") ??
    data.find((hit) => plain(hit.title) === plain(title)) ??
    data[0];
  if (!found) throw new Error(`Deezer has no playlist ${title}`);
  const { data: tracks } = v.parse(
    listOf(playlistTrack),
    await deezer(`/playlist/${found.id}/tracks`, { limit: String(PLAYLIST_TRACKS) }),
  );
  console.log(`Playlist ${found.title}: ${found.nb_tracks} tracks`);
  return {
    title: found.title,
    picture: found.picture_xl ?? null,
    trackCount: found.nb_tracks,
    tracks: tracks.map((track) => ({ artist: track.artist.name, title: track.title })),
  };
}

rmSync(SHOWROOM_CATALOGUE, { recursive: true, force: true });
mkdirSync(SHOWROOM_CATALOGUE, { recursive: true });
const recorded: Recorded[] = [];
const missed: string[] = [];
for (const pick of SHOWROOM_PICKS) {
  await recordPick(pick).then(
    (entry) => recorded.push(entry),
    (error: unknown) => missed.push(`${pick.name}: ${String(error)}`),
  );
}
const playlists = [];
for (const title of PLAYLISTS) playlists.push(await recordPlaylist(title));
const index: CatalogueIndex = {
  artists: recorded.map((entry) => entry.artist),
  library: recorded.flatMap((entry) => entry.library),
  playlists,
};
writeFileSync(
  path.join(SHOWROOM_CATALOGUE, CATALOGUE_INDEX),
  JSON.stringify(index, null, 2) + "\n",
);
if (missed.length > 0) {
  console.error(`Not recorded:\n${missed.join("\n")}`);
  process.exitCode = 1;
}
