import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import { CATALOGUE_ARTISTS, VARIOUS_ARTISTS_ALBUMS, VARIOUS_ARTISTS_ID } from "./artists.ts";
import {
  albumSchema,
  artistSchema,
  CATALOGUE_DIR,
  catalogueFile,
  serializeArtist,
  type CatalogueAlbum,
  type CatalogueArtist,
  type CatalogueRelease,
} from "./catalogue.ts";

const REQUEST_INTERVAL_MS = 400;
const STUDIO_CANDIDATES = 30;
const STUDIO_KEPT = 10;
const RELEASES_KEPT = 4;
const OLD_IDS_KEPT = 2;
const UNKNOWN_DATE = "0001-01-01";

const OTHER_KINDS = [
  { type: "EP", secondary: null, count: 1 },
  { type: "Single", secondary: null, count: 2 },
  { type: "Album", secondary: "Live", count: 1 },
  { type: "Album", secondary: "Compilation", count: 1 },
  { type: "Album", secondary: "Soundtrack", count: 1 },
] as const;

const upstream = process.argv[2]?.replace(/\/+$/, "");
const only = new Set(process.argv.slice(3));
if (!upstream) {
  console.error("Usage: node eden/catalogue/record.ts <metadata server URL> [artist id ...]");
  process.exit(1);
}

const SLOW_ANSWER_RETRY_MS = 5000;

let lastRequest = 0;
async function fetchJson(path: string, retry = true): Promise<unknown> {
  await delay(Math.max(0, lastRequest + REQUEST_INTERVAL_MS - Date.now()));
  lastRequest = Date.now();
  const response = await fetch(`${upstream}${path}`, { signal: AbortSignal.timeout(60_000) });
  if (response.status === 404) return null;
  if (response.status >= 500) {
    if (!retry) {
      console.warn(`Skipped ${path}: the server answered ${response.status} twice`);
      return null;
    }
    await delay(SLOW_ANSWER_RETRY_MS);
    return fetchJson(path, false);
  }
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  const body: unknown = await response.json();
  return body;
}

const sortableDate = (date: string | null | undefined) =>
  date && date !== UNKNOWN_DATE ? date : "9999";

function trimAlbum(album: CatalogueAlbum): CatalogueAlbum {
  const releases = album.releases ?? [];
  const official = releases.filter((release) => release.status === "Official");
  const byDate = (official.length > 0 ? official : releases).toSorted((left, right) =>
    sortableDate(left.releasedate).localeCompare(sortableDate(right.releasedate)),
  );
  const shapes = new Map<string, CatalogueRelease>();
  for (const release of byDate) {
    const formats = (release.media ?? []).map((medium) => medium.Format).join("+");
    const shape = `${release.track_count}|${formats}`;
    if (!shapes.has(shape)) shapes.set(shape, release);
  }
  const chosen = new Set([...shapes.values()].slice(0, RELEASES_KEPT));
  for (const release of byDate) {
    if (chosen.size >= RELEASES_KEPT) break;
    chosen.add(release);
  }
  return {
    ...album,
    overview: "",
    artists: (album.artists ?? []).map((artist) => ({
      ...artist,
      Albums: [],
      links: [],
      overview: "",
    })),
    releases: byDate
      .filter((release) => chosen.has(release))
      .map((release) => ({
        ...release,
        tracks: (release.tracks ?? []).map((track) => ({
          ...track,
          oldids: (track.oldids ?? []).slice(0, OLD_IDS_KEPT),
          oldrecordingids: (track.oldrecordingids ?? []).slice(0, OLD_IDS_KEPT),
        })),
      })),
  };
}

async function fetchAlbum(id: string) {
  const body = await fetchJson(`/album/${id}`);
  if (!body) return null;
  const album = v.parse(albumSchema, body);
  return album.releases?.some((release) => release.tracks?.length) ? trimAlbum(album) : null;
}

async function fetchAlbums(ids: string[]) {
  const albums: CatalogueAlbum[] = [];
  for (const id of ids) {
    const album = await fetchAlbum(id);
    if (album) albums.push(album);
  }
  return albums;
}

function placeholderOverview(artist: CatalogueArtist) {
  const kind = artist.type === "Person" ? "artist" : (artist.type || "artist").toLowerCase();
  const detail = artist.disambiguation ? ` (${artist.disambiguation})` : "";
  return `${artist.artistname}${detail} is a real ${kind} in the Eden test catalogue. Eden replaces biographies with this placeholder.`;
}

async function recordArtist(id: string, name: string) {
  const body = await fetchJson(`/artist/${id}`);
  if (!body) throw new Error(`${name} (${id}) is missing upstream`);
  const artist = v.parse(artistSchema, body);
  const listedUpstream = artist.Albums ?? [];
  const official = listedUpstream.filter((album) => album.ReleaseStatuses?.includes("Official"));
  const ofKind = (type: string, secondary: string | null) =>
    official.filter(
      (album) =>
        album.Type === type &&
        (secondary
          ? album.SecondaryTypes?.length === 1 && album.SecondaryTypes[0] === secondary
          : !album.SecondaryTypes?.length),
    );

  const studio = (
    await fetchAlbums(
      ofKind("Album", null)
        .slice(0, STUDIO_CANDIDATES)
        .map((album) => album.Id),
    )
  )
    .toSorted((left, right) => (right.rating?.Count ?? 0) - (left.rating?.Count ?? 0))
    .slice(0, STUDIO_KEPT);
  const others: CatalogueAlbum[] = [];
  for (const kind of OTHER_KINDS) {
    let found = 0;
    for (const candidate of ofKind(kind.type, kind.secondary).slice(0, kind.count * 2)) {
      if (found >= kind.count) break;
      const album = await fetchAlbum(candidate.Id);
      if (!album) continue;
      others.push(album);
      found += 1;
    }
  }
  const extra = id === VARIOUS_ARTISTS_ID ? await fetchAlbums([...VARIOUS_ARTISTS_ALBUMS]) : [];

  const albums = [...studio, ...others, ...extra].toSorted(
    (left, right) =>
      sortableDate(left.releasedate).localeCompare(sortableDate(right.releasedate)) ||
      left.id.localeCompare(right.id),
  );
  const kept = new Set(albums.map((album) => album.id));
  const listed = listedUpstream.filter((album) => kept.has(album.Id));
  for (const album of extra) {
    if (!listed.some((entry) => entry.Id === album.id)) {
      listed.push({
        Id: album.id,
        Title: album.title,
        Type: album.type,
        SecondaryTypes: album.secondarytypes,
        ReleaseStatuses: ["Official"],
      });
    }
  }
  writeFileSync(
    catalogueFile(id),
    serializeArtist({ ...artist, overview: placeholderOverview(artist), Albums: listed }, albums),
  );
  console.log(`${name}: ${albums.length} albums`);
}

mkdirSync(CATALOGUE_DIR, { recursive: true });
for (const [id, name] of CATALOGUE_ARTISTS) {
  if (only.size > 0 ? !only.has(id) : existsSync(catalogueFile(id))) continue;
  await recordArtist(id, name);
}
