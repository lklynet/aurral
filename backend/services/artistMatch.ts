import { dbOps } from "../db/helpers/index.ts";
import {
  hasArtistName,
  isMetadataNotFoundError,
  listArtistAlbums,
  searchArtists,
} from "./providers/brainzmashProvider.ts";
import { normalizeTitle } from "./providers/brainzmashRanking.ts";
import { coreAlbumTitle, withoutFeaturedArtists } from "./trackMatching/titleText.ts";

type NamedArtist = Awaited<ReturnType<typeof searchArtists>>["items"][number];

const GUESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NO_GUESS_TTL_MS = 12 * 60 * 60 * 1000;

const guessKey = (name: string) => name.trim().toLowerCase();

// Keeps the provider's order, which puts the best-known artist first.
async function namedArtists(name: string) {
  const { items } = await searchArtists(name, { limit: 10, throwOnFailure: true });
  const seen = new Set<string>();
  return items.filter((artist) => {
    if (!artist.id || seen.has(artist.id) || !hasArtistName(name, artist)) return false;
    seen.add(artist.id);
    return true;
  });
}

const albumKeys = (titles: string[]) =>
  new Set(
    titles
      .map((title) => normalizeTitle(coreAlbumTitle(title)).replaceAll(" ", ""))
      .filter(Boolean),
  );

async function heldAlbumCount(artist: NamedArtist, wanted: Set<string>) {
  const albums = await listArtistAlbums(artist.id, { hydrateLimit: 0 }).catch((error) => {
    if (isMetadataNotFoundError(error)) return [];
    throw error;
  });
  return [...albumKeys(albums.map((album) => album.title))].filter((key) => wanted.has(key)).length;
}

// Throws when the provider cannot answer, so a scan can tell an outage from no
// match.
export async function matchLibraryArtist(name: string, albums: string[]): Promise<string | null> {
  const named = await namedArtists(name);
  if (named.length === 0) {
    const lead = withoutFeaturedArtists(name);
    return lead && lead !== name ? matchLibraryArtist(lead, albums) : null;
  }
  if (named.length === 1) return named[0].id;
  const wanted = albumKeys(albums);
  if (wanted.size === 0) return null;
  const counts = await Promise.all(named.map((artist) => heldAlbumCount(artist, wanted)));
  const most = Math.max(...counts);
  return most > 0 && counts.indexOf(most) === counts.lastIndexOf(most)
    ? named[counts.indexOf(most)].id
    : null;
}

async function guess(name: string, wanted: Set<string>): Promise<string | null> {
  const named = await namedArtists(name);
  if (named.length === 0) {
    const lead = withoutFeaturedArtists(name);
    return lead && lead !== name ? guess(lead, wanted) : null;
  }
  if (named.length > 1 && wanted.size > 0) {
    for (const artist of named) {
      if ((await heldAlbumCount(artist, wanted).catch(() => 0)) > 0) return artist.id;
    }
  }
  return named[0].id;
}

function readGuess(name: string) {
  const cached = dbOps.getMusicbrainzArtistMbidCache(guessKey(name));
  if (!cached?.updatedAt) return { fresh: false, mbid: null };
  const age = Date.now() - cached.updatedAt;
  const ttl = cached.mbid ? GUESS_TTL_MS : NO_GUESS_TTL_MS;
  return { fresh: age >= 0 && age < ttl, mbid: cached.mbid };
}

export function cachedArtistGuess(name: string) {
  const cached = readGuess(name);
  return cached.fresh ? cached.mbid : null;
}

// Never throws. A guess the provider could not answer is not remembered, so
// an outage does not hide the artist until the cache expires.
export async function guessArtistMbid(
  name: string | null | undefined,
  { album }: { album?: string | null } = {},
) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const wanted = albumKeys(album ? [album] : []);
  const cached = readGuess(trimmed);
  if (cached.fresh && wanted.size === 0) return cached.mbid;
  try {
    const mbid = await guess(trimmed, wanted);
    if (wanted.size === 0) dbOps.setMusicbrainzArtistMbidCache(guessKey(trimmed), mbid);
    return mbid;
  } catch {
    return cached.mbid;
  }
}
