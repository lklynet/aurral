import { pageOf, releaseDate, type Music, type Outside, type Track } from "./music.ts";

const PLAYLIST_EXTENSION = "https://musicbrainz.org/doc/jspf#playlist";
const WEEKLY_JAMS = "ede00000-0000-4000-8000-0000000000a1";
const ROAD_TRIP = "ede00000-0000-4000-8000-0000000000a2";
const LISTENS = 600;
const LISTEN_GAP_SECONDS = 3 * 3600;

const mbids = (value: string | null) => (value ?? "").split(",").filter(Boolean);

// A listener who plays one hit every three hours, newest first.
function listens(music: Music) {
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: LISTENS }, (_, index) => {
    const track = music.hits[(index * 7) % music.hits.length];
    return track ? [{ track, listenedAt: now - (index + 1) * LISTEN_GAP_SECONDS }] : [];
  }).flat();
}

const jspfTrack = (track: Track) => ({
  title: track.title,
  creator: track.artist.name,
  album: track.album.title,
  duration: track.durationMs,
  identifier: [`https://musicbrainz.org/recording/${track.id}`],
});

function playlists(music: Music, user: string) {
  const playlist = (id: string, title: string, tracks: Track[], sourcePatch?: string) => ({
    playlist: {
      identifier: `https://listenbrainz.org/playlist/${id}`,
      title,
      creator: sourcePatch ? "listenbrainz" : user,
      date: new Date().toISOString(),
      track: tracks.map(jspfTrack),
      extension: {
        [PLAYLIST_EXTENSION]: {
          public: true,
          ...(sourcePatch && {
            created_for: user,
            additional_metadata: { algorithm_metadata: { source_patch: sourcePatch } },
          }),
        },
      },
    },
  });
  return {
    created: [
      playlist(WEEKLY_JAMS, `Weekly Jams for ${user}`, music.hits.slice(0, 30), "weekly-jams"),
    ],
    own: [playlist(ROAD_TRIP, "Road trip", music.hits.slice(30, 55))],
  };
}

export const listenbrainz: Outside = {
  hosts: ["api.listenbrainz.org", "labs.api.listenbrainz.org"],
  respond({ url, method, body }, music) {
    const path = url.pathname.replace(/\/$/, "");
    const param = (name: string) => url.searchParams.get(name);
    if (path === "/similar-artists/json") {
      const artist = music.artistById.get(mbids(param("artist_mbids"))[0] ?? "");
      return (artist ? music.related(artist) : []).map((entry, index) => ({
        artist_mbid: entry.id,
        name: entry.name,
        score: 1000 - index * 40,
      }));
    }
    if (path === "/1/validate-token") return { code: 200, valid: true, user_name: "eden" };
    if (path === "/1/submit-listens" && method === "POST") return { status: "ok" };
    if (path === "/1/metadata/artist") {
      return mbids(param("artist_mbids")).flatMap((id) => {
        const artist = music.artistById.get(id);
        if (!artist) return [];
        const tags = artist.genres.map((tag, index) => ({ tag, count: 20 - index }));
        return [{ artist_mbid: id, name: artist.name, tag: { artist: tags } }];
      });
    }
    if (path === "/1/metadata/release_group") {
      return Object.fromEntries(
        mbids(param("release_group_mbids")).flatMap((id) => {
          const album = music.albumById.get(id);
          return album
            ? [
                [
                  id,
                  {
                    release_group: {
                      name: album.title,
                      date: releaseDate(album),
                      type: album.type,
                    },
                  },
                ],
              ]
            : [];
        }),
      );
    }
    if (path === "/1/popularity/release-group" && method === "POST") {
      const asked: unknown = JSON.parse(body || "{}");
      const ids =
        typeof asked === "object" && asked && "release_group_mbids" in asked
          ? asked.release_group_mbids
          : [];
      return (Array.isArray(ids) ? ids : []).map((entry: unknown) => {
        const id = String(entry);
        const votes = music.albumById.get(id)?.votes ?? 0;
        return {
          release_group_mbid: id,
          total_listen_count: votes ? votes * 10_000 : null,
          total_user_count: votes ? votes * 300 : null,
        };
      });
    }
    if (path === "/1/stats/sitewide/artists") {
      const artists = pageOf(music.popular, url, "count", "offset").map((artist) => ({
        artist_mbid: artist.id,
        artist_name: artist.name,
        listen_count: artist.votes * 5000,
      }));
      return { payload: { artists, range: param("range"), count: artists.length } };
    }
    if (path === "/1/stats/sitewide/recordings") {
      const recordings = pageOf(music.hits, url, "count", "offset").map((track) => ({
        artist_mbids: [track.artist.id],
        artist_name: track.artist.name,
        track_name: track.title,
        release_name: track.album.title,
        recording_mbid: track.id,
        listen_count: track.album.votes * 2000,
      }));
      return { payload: { recordings, range: param("range"), count: recordings.length } };
    }
    if (path === "/1/explore/fresh-releases") {
      const releases = music.fresh.map((album) => ({
        artist_credit_name: album.artist.name,
        artist_mbids: [album.artist.id],
        release_date: releaseDate(album),
        release_group_mbid: album.id,
        release_group_primary_type: album.type,
        release_name: album.title,
      }));
      return { payload: { releases } };
    }
    const [, user, part, kind] =
      /^\/1\/(?:stats\/)?user\/([^/]+)\/(\w+)(?:\/(\w+))?$/.exec(path) ?? [];
    if (user && part === "listens") {
      const before = Number(param("max_ts")) || Number.MAX_SAFE_INTEGER;
      const rows = listens(music)
        .filter((listen) => listen.listenedAt < before)
        .slice(0, Number(param("count")) || 25)
        .map(({ track, listenedAt }) => ({
          listened_at: listenedAt,
          recording_msid: `${track.id}-${listenedAt}`,
          user_name: user,
          track_metadata: {
            track_name: track.title,
            artist_name: track.artist.name,
            release_name: track.album.title,
            additional_info: { duration_ms: track.durationMs },
            mbid_mapping: {
              recording_mbid: track.id,
              artist_mbids: [track.artist.id],
              release_mbid: track.album.id,
            },
          },
        }));
      return { payload: { count: rows.length, user_id: user, listens: rows } };
    }
    if (user && part === "artists") {
      const artists = pageOf(music.popular, url, "count", "offset").map((artist, index) => ({
        artist_mbid: artist.id,
        artist_mbids: [artist.id],
        artist_name: artist.name,
        listen_count: 400 - index,
      }));
      return { payload: { artists, count: artists.length, user_id: user } };
    }
    if (user && part === "playlists") {
      const { created, own } = playlists(music, user);
      const found = kind === "createdfor" ? created : kind ? [] : own;
      return { playlists: found, playlist_count: found.length, count: found.length, offset: 0 };
    }
    const [, playlistId] = /^\/1\/playlist\/([0-9a-f-]{36})$/.exec(path) ?? [];
    if (playlistId) {
      const { created, own } = playlists(music, "eden");
      return [...created, ...own].find((entry) => entry.playlist.identifier.endsWith(playlistId));
    }
    return undefined;
  },
};
