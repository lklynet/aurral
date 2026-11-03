import axios from "../../../lib/axiosFetch.ts";
import { db } from "../../config/db-sqlite.ts";
import { userOps } from "../../db/helpers/index.ts";
import type { LibraryArtistsRow, LibraryEntityGenresRow, PlayEventsRow } from "../../db/rows.ts";
import { lastfmRequest } from "../apiClients/lastfm.ts";
import { listenbrainzRequest } from "../apiClients/listenbrainz.ts";
import { getListenHistory } from "../listeningHistory.ts";
import { scrobbleConnectionStore } from "../scrobbleConnectionStore.ts";
import { normalizeKoitoBaseUrl } from "../koitoClient.ts";
import { getLibraryForTrackMatches } from "../libraryQueryService.ts";
import { guessArtistMbid } from "../artistMatch.ts";
import { fetchDeezerArtistImageUrl } from "../releaseGroupCoverService.ts";
import { deezerGetTrackPreview } from "../apiClients/deezer.ts";
import { buildImageProxyUrl, warmImageProxy, warmPublicImageUrl } from "../imageProxyService.ts";
import { buildCustomArtworkUrl, getCustomArtwork } from "../customArtworkService.ts";
import getSharp from "../sharpConfig.ts";
import { getArtistImage } from "../imageService.ts";
import { songBeats } from "./beats.ts";
import {
  calculateWrapped,
  WRAPPED_SOURCES,
  wrappedKey,
  type WrappedPeriod,
  type WrappedPlay,
} from "./metrics.ts";

const MAX_PLAYS = 100_000;
const PAGE_SIZE = 500;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const object = (value: unknown) => (isRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const number = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const timestamp = (value: unknown) =>
  typeof value === "number" ? value * (value < 1e11 ? 1000 : 1) : Date.parse(text(value));
type Period = WrappedPeriod;
type Source = WrappedPlay["source"];
type Page = { plays: WrappedPlay[]; more: boolean };
const isWrappedSource = (value: string): value is Source =>
  WRAPPED_SOURCES.some((source) => source === value);

export async function readWrappedSource(source: Source, readPage: (page: number) => Promise<Page>) {
  const plays: WrappedPlay[] = [];
  let state: "ready" | "partial" | "unavailable" = "ready";
  try {
    for (let page = 1; ; page++) {
      const next = await readPage(page);
      if (next.more && next.plays.length === 0) {
        state = "partial";
        break;
      }
      const valid = next.plays.filter(
        (play) => play.title && play.artist && Number.isFinite(play.playedAt),
      );
      if (valid.length !== next.plays.length) state = "partial";
      plays.push(...valid.slice(0, MAX_PLAYS - plays.length));
      if (!next.more) break;
      if (plays.length >= MAX_PLAYS || page >= 1000) {
        state = "partial";
        break;
      }
    }
  } catch {
    state = plays.length ? "partial" : "unavailable";
  }
  return { plays, status: { source, state, plays: plays.length } };
}

export function readLocalWrappedHistory(userId: number, period: Period) {
  return db
    .prepare<[number, number, number, number], PlayEventsRow>(
      "SELECT * FROM play_events WHERE user_id = ? AND played_at >= ? AND played_at < ? ORDER BY played_at, id LIMIT ?",
    )
    .all(userId, period.start, period.end, MAX_PLAYS + 1)
    .map((row): WrappedPlay => ({
      source: isWrappedSource(row.source) ? row.source : "aurral",
      account: String(userId),
      id: String(row.id),
      playedAt: row.played_at,
      title: row.title,
      artist: row.artist,
      album: row.album,
      trackMbid: row.track_mbid,
      artistMbid: row.artist_mbid,
      albumMbid: row.album_mbid,
      durationMs: row.duration_ms,
    }));
}

export function lastfmWrappedReader(username: string, period: Period) {
  return async (page: number): Promise<Page> => {
    const data: unknown = await lastfmRequest("user.getRecentTracks", {
      user: username,
      from: Math.ceil(period.start / 1000) - 1,
      to: Math.ceil(period.end / 1000),
      limit: 200,
      page,
    });
    const recent = object(object(data).recenttracks);
    if (!isRecord(recent["@attr"])) throw new Error("Last.fm history unavailable");
    const rows = Array.isArray(recent.track) ? recent.track : recent.track ? [recent.track] : [];
    const plays = rows.flatMap((value): WrappedPlay[] => {
      const row = object(value);
      const date = number(object(row.date).uts);
      if (!date || object(row["@attr"]).nowplaying === "true") return [];
      const artist = object(row.artist);
      const album = object(row.album);
      const artwork = list(row.image)
        .map((image) => text(object(image)["#text"]))
        .filter(Boolean)
        .at(-1);
      return [
        {
          source: "lastfm",
          account: username,
          id: `${date}:${text(artist["#text"])}:${text(row.name)}`,
          playedAt: date * 1000,
          title: text(row.name),
          artist: text(artist["#text"]),
          album: text(album["#text"]),
          trackMbid: text(row.mbid),
          artistMbid: text(artist.mbid),
          albumMbid: text(album.mbid),
          artwork,
        },
      ];
    });
    return { plays, more: page < number(object(recent["@attr"]).totalPages) };
  };
}

export function listenbrainzWrappedReader(username: string, period: Period, token?: string) {
  let before = Math.ceil(period.end / 1000);
  return async (): Promise<Page> => {
    const data: unknown = await listenbrainzRequest(
      `/1/user/${encodeURIComponent(username)}/listens`,
      { max_ts: before, count: 1000 },
      { token },
    );
    const payload = object(object(data).payload);
    if (!Array.isArray(payload.listens)) throw new Error("ListenBrainz history unavailable");
    const rows = payload.listens.map(object);
    const plays = rows.map((row): WrappedPlay => {
      const metadata = object(row.track_metadata);
      const additional = object(metadata.additional_info);
      const mapping = object(metadata.mbid_mapping);
      return {
        source: "listenbrainz",
        account: username,
        id: `${row.listened_at}:${text(row.recording_msid)}:${text(metadata.track_name)}`,
        playedAt: number(row.listened_at) * 1000,
        title: text(metadata.track_name),
        artist: text(metadata.artist_name),
        album: text(metadata.release_name),
        trackMbid: text(additional.recording_mbid) || text(mapping.recording_mbid),
        artistMbid: text(list(additional.artist_mbids)[0]) || text(list(mapping.artist_mbids)[0]),
        albumMbid: text(additional.release_mbid) || text(mapping.release_mbid),
        durationMs:
          number(additional.duration_ms) || number(additional.duration) * 1000 || undefined,
      };
    });
    const oldest = Math.min(...plays.map((play) => play.playedAt / 1000));
    const next = oldest + 1;
    const more = rows.length >= 1000 && oldest * 1000 >= period.start;
    if (more && next >= before) throw new Error("ListenBrainz pagination did not advance");
    before = next;
    return {
      plays: plays.filter((play) => play.playedAt >= period.start && play.playedAt < period.end),
      more,
    };
  };
}

export function koitoReader(baseUrl: string, token: string | undefined, period: Period) {
  return async (page: number): Promise<Page> => {
    const { data }: { data: unknown } = await axios.get(
      `${normalizeKoitoBaseUrl(baseUrl)}/apis/web/v1/listens`,
      {
        params: {
          from: Math.floor(period.start / 1000),
          to: Math.ceil(period.end / 1000) - 1,
          page,
          limit: PAGE_SIZE,
        },
        headers: token ? { Authorization: `Token ${token}` } : {},
        timeout: 20_000,
      },
    );
    const result = object(data);
    if (!Array.isArray(result.items)) throw new Error("Koito history unavailable");
    return {
      plays: result.items.map((value): WrappedPlay => {
        const row = object(value);
        const track = object(row.track);
        const artist = object(list(track.artists)[0]);
        return {
          source: "koito",
          account: baseUrl,
          id: `${text(row.time)}:${track.id}`,
          playedAt: timestamp(row.time),
          title: text(track.title),
          artist: text(artist.name),
        };
      }),
      more: result.has_next_page === true,
    };
  };
}

export async function collectWrappedHistory(userId: number, period: Period) {
  const user = userOps.getUserById(userId);
  if (!user || user.status !== "active") throw new Error("User account unavailable");
  const connections = scrobbleConnectionStore.getConnections(userId);
  const history = getListenHistory(userId);
  const readers: { source: Source; read: (page: number) => Promise<Page> }[] = [];
  const local = readLocalWrappedHistory(userId, period);
  readers.push({
    source: "aurral",
    read: async () => ({ plays: local, more: local.length > MAX_PLAYS }),
  });
  const lastfm = connections.lastfm?.displayName || history.lastfm;
  if (lastfm) readers.push({ source: "lastfm", read: lastfmWrappedReader(lastfm, period) });
  const listenbrainz = connections.listenbrainz?.displayName || history.listenbrainz;
  if (listenbrainz)
    readers.push({
      source: "listenbrainz",
      read: listenbrainzWrappedReader(listenbrainz, period, connections.listenbrainz?.token),
    });
  const koito = connections.koito?.baseUrl || history.koito;
  if (koito)
    readers.push({ source: "koito", read: koitoReader(koito, connections.koito?.token, period) });
  const results = await Promise.all(
    readers.map(({ source, read }) => readWrappedSource(source, read)),
  );
  return {
    plays: results.flatMap((result) => result.plays),
    sources: results.map((result) => result.status),
  };
}

function enrichFromLibrary(plays: WrappedPlay[]) {
  const library = getLibraryForTrackMatches({
    mbids: plays.map((play) => play.trackMbid),
    titles: plays.map((play) => play.title),
  });
  const byMbid = new Map(
    library.tracks.flatMap((track) => (track.mbid ? [[track.mbid, track] as const] : [])),
  );
  const byName = new Map<string, (typeof library.tracks)[number][]>();
  for (const track of library.tracks) {
    const key = `${wrappedKey(track.artistName || "")}\u0000${wrappedKey(track.title)}`;
    byName.set(key, [...(byName.get(key) ?? []), track]);
  }
  const albums = new Map(library.albums.map((album) => [album.id, album]));
  const genres = new Map<string, string[]>();
  for (const row of db
    .prepare<[], Pick<LibraryEntityGenresRow, "entity_kind" | "entity_id" | "name">>(
      "SELECT entity_kind, entity_id, name FROM library_entity_genres",
    )
    .all()) {
    const key = `${row.entity_kind}:${row.entity_id}`;
    genres.set(key, [...(genres.get(key) ?? []), row.name]);
  }
  for (const play of plays) {
    const named = byName.get(`${wrappedKey(play.artist)}\u0000${wrappedKey(play.title)}`);
    const track =
      (play.trackMbid ? byMbid.get(play.trackMbid) : undefined) ??
      (named?.length === 1 ? named[0] : undefined);
    if (!track) continue;
    const album =
      track.albums
        .map((link) => albums.get(link.albumId))
        .find(
          (album) => album && (!play.album || wrappedKey(album.title) === wrappedKey(play.album)),
        ) ?? undefined;
    const file = track.files.find(
      (file) => file.available && (!album || !file.albumId || file.albumId === album.id),
    );
    play.trackMbid ||= track.mbid;
    play.durationMs ||= file?.durationMs;
    const libraryAlbumId = file && (file.albumId ?? album?.id);
    if (libraryAlbumId) {
      play.libraryTrackId = track.id;
      play.libraryAlbumId = libraryAlbumId;
    }
    if (!album) continue;
    play.album ||= album.title;
    play.albumMbid ||= album.releaseGroupMbid || album.mbid;
    const cover = album.metadata?.images?.find((image) =>
      /^https?:/.test(image.remoteUrl || image.url || ""),
    );
    play.artwork ||= cover?.remoteUrl || cover?.url;
    play.genres = [
      ...new Set([
        ...(play.genres ?? []),
        ...(genres.get(`tracks:${track.id}`) ?? []),
        ...(genres.get(`albums:${album.id}`) ?? []),
        ...(genres.get(`artists:${album.artistId}`) ?? []),
      ]),
    ];
  }
}

export function vividColor(pixels: Uint8Array) {
  const bins = new Map<number, { score: number; rgb: [number, number, number]; count: number }>();
  for (let index = 0; index + 2 < pixels.length; index += 3) {
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    const key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
    const bin = bins.get(key) ?? { score: 0, rgb: [0, 0, 0], count: 0 };
    bin.score += 0.15 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    bin.rgb[0] += r;
    bin.rgb[1] += g;
    bin.rgb[2] += b;
    bin.count++;
    bins.set(key, bin);
  }
  const best = [...bins.values()].reduce((top, bin) => (bin.score > top.score ? bin : top));
  return `#${best.rgb
    .map((value) =>
      Math.round(value / best.count)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

async function artworkColor(source: string, localPath?: string) {
  const [imagePath, sharp] = await Promise.all([
    localPath ?? warmImageProxy(source).then((entry) => entry.imagePath),
    getSharp(),
  ]);
  return vividColor(
    await sharp(imagePath).resize(24, 24, { fit: "cover" }).removeAlpha().raw().toBuffer(),
  );
}

async function cachedImage(...sources: (string | null | undefined)[]) {
  for (const source of sources) {
    const url = buildImageProxyUrl(source);
    if (url && (await warmPublicImageUrl(url))) return url;
  }
  return null;
}

async function artistPhoto({
  name,
  album,
  mbid,
}: {
  name: string;
  album: string | null;
  mbid: string | null;
}) {
  const known =
    mbid ||
    db
      .prepare<[string], Pick<LibraryArtistsRow, "mbid">>(
        "SELECT mbid FROM library_artists WHERE name = ? COLLATE NOCASE AND mbid IS NOT NULL",
      )
      .get(name)?.mbid ||
    (await guessArtistMbid(name, { album }));
  const photo = known
    ? (await getArtistImage(known, { artistName: name }).catch(() => null))?.url
    : null;
  return (
    (await cachedImage(photo)) ?? cachedImage(await fetchDeezerArtistImageUrl({ artistName: name }))
  );
}

export async function buildWrappedSummary(userId: number, period: Period) {
  const history = await collectWrappedHistory(userId, period);
  const summary = calculateWrapped(history.plays, period, enrichFromLibrary);
  const customPaths = new Map<string, string>();
  const cover = async (
    row: { artwork: string | null },
    ...targets: [kind: "track" | "album", id: number | null][]
  ) => {
    for (const [kind, id] of targets) {
      const custom = id == null ? null : getCustomArtwork(kind, id);
      if (!custom) continue;
      row.artwork = buildCustomArtworkUrl(kind, custom.id, custom.updatedAt);
      customPaths.set(row.artwork, custom.filePath);
      return;
    }
    row.artwork = await cachedImage(row.artwork);
  };
  await Promise.all([
    ...summary.topSongs.map((song) =>
      cover(song, ["track", song.libraryTrackId], ["album", song.libraryAlbumId]),
    ),
    ...summary.topAlbums.map((album) => cover(album, ["album", album.libraryAlbumId])),
  ]);
  const covers = [...summary.topSongs, ...summary.topAlbums];
  await Promise.all(
    summary.topArtists.map(async (artist) => {
      artist.artwork =
        (await artistPhoto(artist)) ??
        (await cachedImage(artist.artwork)) ??
        covers.find((row) => row.artwork && wrappedKey(row.artist) === artist.key)?.artwork ??
        null;
    }),
  );
  const featured = summary.topSongs.slice(0, 5);
  const artistSong = summary.topSongs.find(
    (song) => wrappedKey(song.artist) === summary.topArtists[0]?.key,
  );
  const album = summary.topAlbums[0];
  const albumSong =
    album &&
    summary.topSongs.find(
      (song) =>
        song.album && `${wrappedKey(song.artist)}\u0000${wrappedKey(song.album)}` === album.key,
    );
  for (const song of [artistSong, albumSong])
    if (song && !featured.includes(song)) featured.push(song);
  await Promise.all([
    ...[...summary.topArtists, ...featured, ...summary.topAlbums].map(async (row) => {
      if (row.artwork)
        row.color = await artworkColor(row.artwork, customPaths.get(row.artwork)).catch(() => null);
    }),
    ...featured.map(async (song) => {
      const preview = await deezerGetTrackPreview({
        artistName: song.artist,
        trackName: song.name,
      });
      song.preview = preview?.preview_url ?? null;
    }),
  ]);
  await Promise.all(
    summary.topSongs
      .filter(
        (song) =>
          song.preview !== null || (song.libraryTrackId !== null && song.libraryAlbumId !== null),
      )
      .slice(0, 4)
      .map(async (song) => {
        song.beats = await songBeats(song);
      }),
  );
  return { ...summary, sources: history.sources };
}
