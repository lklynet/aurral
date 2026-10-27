import axios from "../../../lib/axiosFetch.ts";
import { db } from "../../config/db-sqlite.ts";
import { dbOps, userOps } from "../../db/helpers/index.ts";
import type { PlayEventsRow } from "../../db/rows.ts";
import { lastfmRequest } from "../apiClients/lastfm.ts";
import { listenbrainzRequest } from "../apiClients/listenbrainz.ts";
import { getListenHistoryProfile } from "../listeningHistory.ts";
import { scrobbleConnectionStore } from "../scrobbleConnectionStore.ts";
import { normalizeKoitoBaseUrl } from "../koitoClient.ts";
import { NavidromeClient } from "../navidrome.ts";
import { PlexClient } from "../plex.ts";
import { plexConnectionStore } from "../plex/plexConnectionStore.ts";
import { JellyfinClient } from "../jellyfin.ts";
import { getLibraryForTrackMatches } from "../libraryQueryService.ts";
import { buildImageProxyUrl } from "../imageProxyService.ts";
import { getArtistImage } from "../imageService.ts";
import { calculateWrapped, wrappedName, type WrappedPlay, type wrappedPeriod } from "./metrics.ts";

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
type Period = ReturnType<typeof wrappedPeriod>;
type Source = WrappedPlay["source"];
type Page = { plays: WrappedPlay[]; more: boolean };

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
      source: "aurral",
      account: String(userId),
      id: String(row.id),
      playedAt: row.played_at,
      startedAt:
        row.source === "native-player" && row.duration_ms
          ? row.played_at - row.duration_ms
          : undefined,
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
      return {
        source: "listenbrainz",
        account: username,
        id: `${row.listened_at}:${text(row.recording_msid)}:${text(metadata.track_name)}`,
        playedAt: number(row.listened_at) * 1000,
        title: text(metadata.track_name),
        artist: text(metadata.artist_name),
        album: text(metadata.release_name),
        trackMbid: text(additional.recording_mbid),
        artistMbid: text(list(additional.artist_mbids)[0]),
        albumMbid: text(additional.release_mbid),
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
          artistMbid: text(artist.musicbrainz_id),
        };
      }),
      more: result.has_next_page === true,
    };
  };
}

export function navidromeReader(client: NavidromeClient, account: string, period: Period) {
  const songs = new Map<string, Record<string, unknown>>();
  return async (page: number): Promise<Page> => {
    const query = new URLSearchParams({
      from: String(Math.floor(period.start / 1000)),
      to: String(Math.ceil(period.end / 1000) - 1),
      _start: String((page - 1) * PAGE_SIZE),
      _end: String(page * PAGE_SIZE),
      _sort: "submission_time",
      _order: "ASC",
    });
    const raw: unknown = await client._nativeRequest("GET", `/api/scrobble?${query}`, null, {
      timeout: 20_000,
    });
    if (!Array.isArray(raw)) throw new Error("Navidrome history API unavailable");
    const rows = raw.map(object);
    for (const id of new Set(rows.map((row) => text(row.mediaFileId)).filter(Boolean))) {
      if (!songs.has(id))
        songs.set(
          id,
          object(
            await client._nativeRequest("GET", `/api/song/${encodeURIComponent(id)}`, null, {
              timeout: 20_000,
            }),
          ),
        );
    }
    return {
      plays: rows.map((row): WrappedPlay => {
        const song = songs.get(text(row.mediaFileId)) ?? {};
        return {
          source: "navidrome",
          account,
          id: String(row.id),
          playedAt: timestamp(number(row.submissionTime)),
          title: text(song.title),
          artist: text(song.artist),
          album: text(song.album),
          trackMbid: text(song.mbzRecordingID),
          artistMbid: text(song.mbzArtistID),
          durationMs: number(song.duration) * 1000 || undefined,
          genres: list(song.genres)
            .map((genre) => text(object(genre).name))
            .filter(Boolean),
        };
      }),
      more: rows.length === PAGE_SIZE,
    };
  };
}

export function plexReader(client: PlexClient, accountId: string | number | null, period: Period) {
  return async (page: number): Promise<Page> => {
    const raw: unknown = await client.request("/status/sessions/history/all", {
      params: {
        type: 10,
        "viewedAt>": Math.floor(period.start / 1000) - 1,
        "viewedAt<": Math.ceil(period.end / 1000),
        accountID: accountId,
        "X-Plex-Container-Start": (page - 1) * PAGE_SIZE,
        "X-Plex-Container-Size": PAGE_SIZE,
      },
      timeout: 20_000,
    });
    const container = object(object(raw).MediaContainer);
    if (!Array.isArray(container.Metadata) && number(container.size) !== 0)
      throw new Error("Plex history unavailable");
    const rows = list(container.Metadata)
      .map(object)
      .filter((row) => row.type === "track");
    return {
      plays: rows.map((row): WrappedPlay => ({
        source: "plex",
        account: String(accountId ?? "owner"),
        id: String(row.historyKey || `${row.ratingKey}:${row.viewedAt}`),
        playedAt: timestamp(number(row.viewedAt)),
        title: text(row.title),
        artist: text(row.grandparentTitle),
        album: text(row.parentTitle),
        durationMs: number(row.duration) || undefined,
      })),
      more: page * PAGE_SIZE < number(container.totalSize),
    };
  };
}

export function jellyfinReader(client: JellyfinClient, account: string, period: Period) {
  return async (page: number): Promise<Page> => {
    if (page !== 1) return { plays: [], more: false };
    const quoted = account.replaceAll("-", "").replaceAll("'", "''");
    const start = new Date(period.start).toISOString().slice(0, 19).replace("T", " ");
    const end = new Date(period.end).toISOString().slice(0, 19).replace("T", " ");
    const raw: unknown = await client.request("POST", "/user_usage_stats/submit_custom_query", {
      data: {
        CustomQueryString: `SELECT DateCreated, ItemId, PlayDuration FROM PlaybackActivity WHERE REPLACE(UserId, '-', '') = '${quoted}' AND ItemType = 'Audio' AND DateCreated >= '${start}' AND DateCreated < '${end}' ORDER BY DateCreated LIMIT ${MAX_PLAYS + 1}`,
      },
    });
    const result = object(raw);
    if (/error|failed|no such|not authorized/i.test(text(result.message)))
      throw new Error("Playback Reporting query unavailable");
    if (!Array.isArray(result.results)) throw new Error("Jellyfin Playback Reporting unavailable");
    const rows = result.results.map(list);
    const items = new Map<string, Record<string, unknown>>();
    const ids = [...new Set(rows.map((row) => text(row[1])).filter(Boolean))];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const response: unknown = await client.request("GET", "/Items", {
        params: {
          ids: ids.slice(offset, offset + 100).join(","),
          userId: account,
          fields: "Genres",
          enableImages: false,
        },
      });
      for (const value of list(object(response).Items)) {
        const item = object(value);
        items.set(text(item.Id), item);
      }
    }
    return {
      plays: rows.map((row, index): WrappedPlay => {
        const item = items.get(text(row[1])) ?? {};
        const date = text(row[0]);
        return {
          source: "jellyfin",
          account,
          id: `${date}:${row[1]}:${index}`,
          playedAt: Date.parse(date.includes("T") ? date : `${date.replace(" ", "T")}Z`),
          title: text(item.Name),
          artist: text(list(item.Artists)[0]),
          album: text(item.Album),
          durationMs: number(item.RunTimeTicks) / 10000 || undefined,
          listenedMs: number(row[2]) * 1000 || undefined,
          genres: list(item.Genres).map(text).filter(Boolean),
        };
      }),
      more: rows.length > MAX_PLAYS,
    };
  };
}

export async function collectWrappedHistory(userId: number, period: Period) {
  const user = userOps.getUserById(userId);
  if (!user || user.status !== "active") throw new Error("User account unavailable");
  const settings = dbOps.getSettings();
  const connections = scrobbleConnectionStore.getConnections(userId);
  const profile = getListenHistoryProfile(user);
  const readers: { source: Source; read: (page: number) => Promise<Page> }[] = [];
  const local = readLocalWrappedHistory(userId, period);
  readers.push({
    source: "aurral",
    read: async () => ({ plays: local, more: local.length > MAX_PLAYS }),
  });
  const lastfm =
    connections.lastfm?.displayName ||
    (profile.listenHistoryProvider === "lastfm" ? profile.listenHistoryUsername : null);
  if (lastfm) readers.push({ source: "lastfm", read: lastfmWrappedReader(lastfm, period) });
  const listenbrainz =
    connections.listenbrainz?.displayName ||
    (profile.listenHistoryProvider === "listenbrainz" ? profile.listenHistoryUsername : null);
  if (listenbrainz)
    readers.push({
      source: "listenbrainz",
      read: listenbrainzWrappedReader(listenbrainz, period, connections.listenbrainz?.token),
    });
  const koito = connections.koito?.baseUrl || profile.listenHistoryUrl;
  if (koito)
    readers.push({ source: "koito", read: koitoReader(koito, connections.koito?.token, period) });
  const soleUser = userOps.getAllUsers().filter((user) => user.status === "active").length === 1;
  const navidrome = settings.integrations?.navidrome;
  if (
    navidrome?.url &&
    (soleUser || wrappedName(navidrome.username || "") === wrappedName(user.username))
  ) {
    readers.push({
      source: "navidrome",
      read: navidromeReader(
        new NavidromeClient(navidrome.url, navidrome.username || "", navidrome.password || ""),
        navidrome.username || "",
        period,
      ),
    });
  }
  const plex = settings.integrations?.plex;
  const linkedPlex = plexConnectionStore.getConnection(userId);
  if (plex?.url && (linkedPlex?.plexAccountId != null || soleUser)) {
    const client = new PlexClient(
      plex.url,
      linkedPlex?.token || plex.token,
      linkedPlex?.clientId || plex.clientId,
    );
    let read: ReturnType<typeof plexReader> | undefined;
    readers.push({
      source: "plex",
      read: async (page) => {
        if (!read) {
          const raw: unknown = await client.request("/accounts", { timeout: 20_000 });
          const accounts = list(object(object(raw).MediaContainer).Account).map(object);
          let username = text(linkedPlex?.plexUsername) || plex.plexUsername || "";
          if (!username && linkedPlex?.plexAccountId == null)
            username = text(
              object(await PlexClient.validateToken(client.token, client.clientId)).username,
            );
          const matches = accounts.filter((account) =>
            linkedPlex?.plexAccountId != null
              ? String(account.id) === String(linkedPlex.plexAccountId)
              : username && wrappedName(text(account.name)) === wrappedName(username),
          );
          if (matches.length !== 1) throw new Error("Plex account could not be identified");
          const id = matches[0].id;
          if (typeof id !== "string" && typeof id !== "number")
            throw new Error("Plex account has no ID");
          read = plexReader(client, id, period);
        }
        return read(page);
      },
    });
  }
  const jellyfin = settings.integrations?.jellyfin;
  if (jellyfin?.url && jellyfin.userId) {
    const client = new JellyfinClient(jellyfin.url, jellyfin.apiKey || "", jellyfin.userId);
    const read = jellyfinReader(client, jellyfin.userId, period);
    readers.push({
      source: "jellyfin",
      read: async (page) => {
        if (
          !soleUser &&
          wrappedName(text(object(await client.getUser()).Name)) !== wrappedName(user.username)
        )
          throw new Error("Link your playback account first");
        return read(page);
      },
    });
  }
  const results = await Promise.all(
    readers.map(({ source, read }) => readWrappedSource(source, read)),
  );
  return {
    plays: results.flatMap((result) => result.plays),
    sources: results.map((result) => result.status),
  };
}

export async function buildWrappedSummary(userId: number, period: Period) {
  const history = await collectWrappedHistory(userId, period);
  const plays = history.plays.filter(
    (play) => play.playedAt >= period.start && play.playedAt < period.end,
  );
  const library = getLibraryForTrackMatches({
    mbids: plays.map((play) => play.trackMbid),
    titles: plays.map((play) => play.title),
  });
  const byMbid = new Map(
    library.tracks.filter((track) => track.mbid).map((track) => [track.mbid, track]),
  );
  const byName = new Map<string, typeof library.tracks>();
  for (const track of library.tracks) {
    const key = `${wrappedName(track.artistName || "")}\u0000${wrappedName(track.title)}`;
    byName.set(key, [...(byName.get(key) ?? []), track]);
  }
  const albums = new Map(library.albums.map((album) => [album.id, album]));
  const genres = db
    .prepare<[], { entity_kind: string; entity_id: number; name: string }>(
      "SELECT entity_kind, entity_id, name FROM library_entity_genres",
    )
    .all();
  const genreMap = new Map<string, string[]>();
  for (const row of genres) {
    const key = `${row.entity_kind}:${row.entity_id}`;
    genreMap.set(key, [...(genreMap.get(key) ?? []), row.name]);
  }
  for (const play of plays) {
    const matches = byName.get(`${wrappedName(play.artist)}\u0000${wrappedName(play.title)}`);
    const track =
      (play.trackMbid ? byMbid.get(play.trackMbid) : undefined) ||
      (matches?.length === 1 ? matches[0] : undefined);
    if (!track) continue;
    const album = track.albums
      .map((link) => albums.get(link.albumId))
      .find(
        (album) => album && (!play.album || wrappedName(album.title) === wrappedName(play.album)),
      );
    const file = track.files.find(
      (file) => file.available && (!album || file.albumId === album.id || !file.albumId),
    );
    play.trackMbid ||= track.mbid;
    play.durationMs ||= file?.durationMs;
    if (file && album) {
      play.libraryTrackId = track.id;
      play.libraryAlbumId = album.id;
    }
    if (album) {
      play.album ||= album.title;
      play.albumMbid ||= album.releaseGroupMbid || album.mbid;
      const cover = album.metadata?.images?.find((image) =>
        /^https?:/.test(image.remoteUrl || image.url || ""),
      );
      play.artwork ||= cover?.remoteUrl || cover?.url;
      play.genres = [
        ...new Set([
          ...(play.genres ?? []),
          ...(genreMap.get(`albums:${album.id}`) ?? []),
          ...(genreMap.get(`artists:${album.artistId}`) ?? []),
          ...(genreMap.get(`tracks:${track.id}`) ?? []),
        ]),
      ];
    }
  }
  const summary = calculateWrapped(plays, period);
  await Promise.all(
    summary.topArtists.map(async (artist) => {
      if (!artist.mbid) return;
      try {
        artist.artwork =
          (await getArtistImage(artist.mbid, { artistName: artist.name })).url || artist.artwork;
      } catch {}
    }),
  );
  for (const row of [...summary.topSongs, ...summary.topArtists, ...summary.topAlbums])
    row.artwork = buildImageProxyUrl(row.artwork);
  return { ...summary, sources: history.sources };
}
