import { stableUuid } from "../brainzmash.mjs";
import { catalogTracks, trackDurationSeconds } from "../runtime.mjs";

const PLAYLIST_EXTENSION = "https://musicbrainz.org/doc/jspf#playlist";
const TRACK_EXTENSION = "https://musicbrainz.org/doc/jspf#track";

export function createListenbrainz(catalog, { token, username }) {
  const tracks = catalogTracks(catalog);
  const state = { listens: [] };
  const week = new Date(Date.UTC(2026, 8, 28)).toISOString();
  const playlists = [
    { id: stableUuid("listenbrainz:mine"), title: "Lab Favourites", picks: (index) => index % 3 === 0 },
    { id: stableUuid("listenbrainz:weekly-jams"), title: "Weekly Jams for lab-listener, week of 2026-09-28", source: "weekly-jams", picks: (index) => index % 2 === 0 },
    { id: stableUuid("listenbrainz:weekly-exploration"), title: "Weekly Exploration for lab-listener, week of 2026-09-28", source: "weekly-exploration", picks: (index) => index % 2 === 1 },
  ];
  const jspf = (playlist, withTracks) => ({
    title: playlist.title,
    creator: playlist.source ? "listenbrainz" : username,
    identifier: `https://listenbrainz.org/playlist/${playlist.id}`,
    date: week,
    extension: {
      [PLAYLIST_EXTENSION]: {
        creator: playlist.source ? "listenbrainz" : username,
        last_modified_at: week,
        public: true,
        ...(playlist.source ? { created_for: username, additional_metadata: { algorithm_metadata: { source_patch: playlist.source } } } : {}),
      },
    },
    track: withTracks
      ? tracks.filter((_entry, index) => playlist.picks(index)).map((entry) => ({
        title: entry.title,
        creator: entry.artist.name,
        album: entry.album.title,
        duration: trackDurationSeconds(entry.index) * 1000,
        identifier: [`https://musicbrainz.org/recording/${stableUuid(`${entry.album.id}:recording:${entry.index + 1}`)}`],
        extension: {
          [TRACK_EXTENSION]: {
            artist_identifiers: [`https://musicbrainz.org/artist/${entry.artist.id}`],
            release_identifier: `https://musicbrainz.org/release/${stableUuid(`${entry.album.id}:release`)}`,
          },
        },
      }))
      : [],
  });
  const artistStats = (scale) => ({
    payload: {
      count: catalog.artists.length,
      offset: 0,
      total_artist_count: catalog.artists.length,
      range: "week",
      artists: catalog.artists.map((artist, index) => ({ artist_name: artist.name, artist_mbids: [artist.id], listen_count: scale - index * 7 })),
    },
  });
  const page = (items, url) => {
    const count = Number(url.searchParams.get("count")) || 25;
    const offset = Number(url.searchParams.get("offset")) || 0;
    return { playlist_count: items.length, count, offset, playlists: items.slice(offset, offset + count).map((playlist) => ({ playlist: jspf(playlist, false) })) };
  };

  const handle = ({ method, url, headers, body }) => {
    const authorized = String(headers.authorization || "") === `Token ${token}`;
    const path = url.pathname.replace(/\/+$/, "");
    if (method === "GET" && path === "/1/validate-token") {
      return { status: 200, body: authorized ? { code: 200, message: "Token valid.", valid: true, user_name: username } : { code: 200, message: "Token invalid.", valid: false } };
    }
    if (method === "POST" && path === "/1/submit-listens") {
      if (!authorized) return { status: 401, body: { code: 401, error: "Invalid authorization token." } };
      if (!Array.isArray(body?.payload) || !["single", "import", "playing_now"].includes(body.listen_type)) {
        return { status: 400, body: { code: 400, error: "Invalid JSON document submitted." } };
      }
      for (const listen of body.payload) state.listens.push({ type: body.listen_type, ...listen });
      return { status: 200, body: { status: "ok" } };
    }
    if (method !== "GET") return null;
    if (path === "/1/stats/sitewide/artists") return { status: 200, body: artistStats(9000) };
    const userStats = /^\/1\/stats\/user\/([^/]+)\/artists$/.exec(path);
    if (userStats) return decodeURIComponent(userStats[1]) === username ? { status: 200, body: artistStats(140) } : { status: 404, body: { code: 404, error: "Cannot find user" } };
    const userPlaylists = /^\/1\/user\/([^/]+)\/playlists(\/createdfor)?$/.exec(path);
    if (userPlaylists) {
      if (decodeURIComponent(userPlaylists[1]) !== username) return { status: 404, body: { code: 404, error: "Cannot find user" } };
      return { status: 200, body: page(playlists.filter((playlist) => Boolean(playlist.source) === Boolean(userPlaylists[2])), url) };
    }
    const single = /^\/1\/playlist\/([0-9a-f-]{36})$/.exec(path);
    if (single) {
      const playlist = playlists.find((entry) => entry.id === single[1]);
      return playlist ? { status: 200, body: { playlist: jspf(playlist, true) } } : { status: 404, body: { code: 404, error: "Cannot find playlist" } };
    }
    return null;
  };
  handle.state = state;
  handle.restore = (saved) => Object.assign(state, saved);
  return { name: "listenbrainz", hosts: ["api.listenbrainz.org"], handle };
}
