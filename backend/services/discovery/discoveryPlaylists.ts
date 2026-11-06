import * as v from "valibot";
import { db } from "../../config/db-sqlite.ts";
import {
  deezerGetAlbumTracks,
  deezerGetArtistTopTrackList,
  resolveDeezerAlbumForPreview,
} from "../apiClients/deezer.ts";
import { listOf } from "../../db/helpers/storedSchemas.ts";
import { getTopPlayedArtists } from "../playEventService.ts";
import { resolveLibraryTracks } from "../subsonicLibraryService.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";
import { getFreshReleasesByArtists, refreshFreshReleases } from "./freshReleases.ts";
import { interleaveLists, mapWithConcurrency } from "./helpers.ts";
import { seededRandom } from "./mixes.ts";
import { getUserDiscovery } from "./userDiscovery.ts";
import type { DiscoveryPlaylistsRow } from "../../db/rows.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PLAYLIST_SIZE = 30;
const MIN_TRACKS = 10;
const CONCURRENCY = 1;
const NEW_TO_YOU_PICKS = 3;
const DEEP_CUT_ARTISTS = 10;
const DEEP_CUT_SKIP = 5;
const DEEP_CUTS_PER_ARTIST = 3;

export const catalogTrackSchema = v.object({
  artistName: v.string(),
  trackName: v.string(),
  albumName: v.nullable(v.string()),
  durationMs: v.nullable(v.number()),
  preview_url: v.nullable(v.string()),
  artworkUrl: v.nullable(v.string()),
  deezerAlbumId: v.nullable(v.string()),
});

export type CatalogTrack = v.InferOutput<typeof catalogTrackSchema>;

const tracksSchema = listOf(catalogTrackSchema);

const PLAYLISTS = [
  {
    id: "new-to-you",
    name: "New to You",
    description: "Top songs from artists you might like",
  },
  {
    id: "new-releases",
    name: "New Releases",
    description: "Fresh songs from artists in your Library",
  },
  {
    id: "deep-cuts",
    name: "Deep Cuts",
    description: "Lesser known songs from artists you play most",
  },
] as const;

type PlaylistId = (typeof PLAYLISTS)[number]["id"];

const isPresent = <T>(value: T | null): value is T => value !== null;

async function topTracks(artistName: string, limit: number) {
  const tracks = await deezerGetArtistTopTrackList(artistName, { limit });
  return tracks.flatMap((track): CatalogTrack[] =>
    track.previewUrl
      ? [
          {
            artistName: track.artistName,
            trackName: track.name,
            albumName: track.albumName,
            durationMs: track.durationMs,
            preview_url: track.previewUrl,
            artworkUrl: track.artworkUrl,
            deezerAlbumId: track.deezerAlbumId,
          },
        ]
      : [],
  );
}

async function forEachArtist<T>(artists: T[], work: (artist: T) => Promise<CatalogTrack[]>) {
  let failure: unknown = null;
  let answered = 0;
  const results = await mapWithConcurrency(artists, CONCURRENCY, (artist) =>
    work(artist).then(
      (tracks) => {
        answered += 1;
        return tracks;
      },
      (error: unknown) => {
        failure = error;
        return [];
      },
    ),
  );
  if (artists.length && !answered) throw failure;
  return results;
}

const withoutOwned = (tracks: CatalogTrack[]) => {
  const owned = resolveLibraryTracks(tracks);
  return tracks.filter((_, index) => !owned[index]);
};

async function newToYou(userId: number, random: () => number) {
  const { recommendations } = getUserDiscovery(userId, PLAYLIST_SIZE, 0).body;
  const picks = await forEachArtist(recommendations, async (artist) => {
    const tracks = await topTracks(artist.name, NEW_TO_YOU_PICKS);
    return tracks.slice(Math.floor(random() * tracks.length)).slice(0, 1);
  });
  return picks.flat();
}

async function newReleases(now: number) {
  const mbids = db
    .prepare<[], { mbid: string }>(
      "SELECT DISTINCT mbid FROM library_artists WHERE mbid IS NOT NULL AND mbid != ''",
    )
    .all()
    .map((row) => row.mbid);
  if (!mbids.length) return [];
  let releases = getFreshReleasesByArtists(mbids);
  if (!releases.length) {
    await refreshFreshReleases();
    releases = getFreshReleasesByArtists(mbids);
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const recent = releases
    .filter((release) => release.releaseDate <= today)
    .sort((left, right) => right.releaseDate.localeCompare(left.releaseDate))
    .slice(0, PLAYLIST_SIZE);
  const picks = await mapWithConcurrency(recent, CONCURRENCY, async (release) => {
    const album = await resolveDeezerAlbumForPreview({
      artistName: release.artistName,
      albumTitle: release.albumName,
      releaseType: release.albumType,
      releaseDate: release.releaseDate,
    }).catch(() => null);
    if (!album) return null;
    const [best] = (await deezerGetAlbumTracks(album.id))
      .filter((track) => track.preview_url)
      .sort((left, right) => right.rank - left.rank);
    return best
      ? {
          artistName: release.artistName,
          trackName: best.title,
          albumName: release.albumName,
          durationMs: best.duration_ms,
          preview_url: best.preview_url,
          artworkUrl: album._coverUrl,
          deezerAlbumId: String(album.id),
        }
      : null;
  });
  const found = picks.filter(isPresent);
  if (recent.length && !found.length) throw new Error("No new release could be found on Deezer");
  return found;
}

async function deepCuts(userId: number, random: () => number) {
  const artists = getTopPlayedArtists(userId, { limit: DEEP_CUT_ARTISTS });
  const perArtist = await forEachArtist(artists, async (artist) => {
    const cuts = withoutOwned((await topTracks(artist.artistName, 50)).slice(DEEP_CUT_SKIP));
    return cuts
      .map((track) => ({ track, key: random() }))
      .sort((left, right) => left.key - right.key)
      .slice(0, DEEP_CUTS_PER_ARTIST)
      .map(({ track }) => track);
  });
  return interleaveLists(...perArtist);
}

const deleteStmt = db.prepare<[number, string]>(
  "DELETE FROM discovery_playlists WHERE user_id = ? AND id = ?",
);
const insertStmt = db.prepare<[number, string, string, string, string, number]>(`
  INSERT INTO discovery_playlists (user_id, id, name, description, tracks_json, built_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const selectStmt = db.prepare<[number], DiscoveryPlaylistsRow>(
  "SELECT * FROM discovery_playlists WHERE user_id = ?",
);

const readTracks = (json: string) => {
  try {
    const parsed = v.safeParse(tracksSchema, JSON.parse(json));
    return parsed.success ? parsed.output : [];
  } catch {
    return [];
  }
};

const replacePlaylists = db.transaction(
  (userId: number, built: { id: PlaylistId; tracks: CatalogTrack[] | null }[], now: number) => {
    for (const { id, tracks } of built) {
      const playlist = PLAYLISTS.find((entry) => entry.id === id);
      if (!playlist || !tracks) continue;
      deleteStmt.run(userId, id);
      if (tracks.length < MIN_TRACKS) continue;
      insertStmt.run(
        userId,
        id,
        playlist.name,
        playlist.description,
        JSON.stringify(tracks.slice(0, PLAYLIST_SIZE)),
        now,
      );
    }
  },
);

export async function buildDiscoveryPlaylists(userId: number, now = Date.now()) {
  const week = Math.floor(now / WEEK_MS);
  const random = (id: PlaylistId) => seededRandom(`${userId}:${week}:${id}`);
  const settle = (id: PlaylistId, work: Promise<CatalogTrack[]>) =>
    work.then(
      (tracks): { id: PlaylistId; tracks: CatalogTrack[] | null } => ({ id, tracks }),
      (error: unknown) => {
        logger.info("discovery", "Discovery playlist was not rebuilt", {
          userId,
          playlist: id,
          reason: safeLogDiagnostic(error),
        });
        return { id, tracks: null };
      },
    );
  const built = [
    await settle("new-to-you", newToYou(userId, random("new-to-you"))),
    await settle("new-releases", newReleases(now)),
    await settle("deep-cuts", deepCuts(userId, random("deep-cuts"))),
  ];
  replacePlaylists(userId, built, now);
}

export function getDiscoveryPlaylists(userId: number) {
  const rows = new Map(selectStmt.all(userId).map((row) => [row.id, row]));
  return PLAYLISTS.flatMap((playlist) => {
    const row = rows.get(playlist.id);
    return row
      ? [
          {
            id: row.id,
            name: row.name,
            description: row.description,
            builtAt: row.built_at,
            tracks: readTracks(row.tracks_json),
          },
        ]
      : [];
  });
}

export function getDiscoveryPlaylist(userId: number, id: string) {
  return getDiscoveryPlaylists(userId).find((playlist) => playlist.id === id) ?? null;
}
