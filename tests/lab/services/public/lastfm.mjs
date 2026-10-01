import { createHash, randomUUID } from "node:crypto";
import { stableUuid } from "../brainzmash.mjs";
import { catalogTracks, searchWords, similarArtists, solidPng, trackDurationSeconds } from "../runtime.mjs";

const IMAGE_HOST = "https://lastfm.freetls.fastly.net";

export function createLastfm(catalog, { apiKey, apiSecret, sessionKey }) {
  const tracks = catalogTracks(catalog);
  const state = { tokens: [], sessions: sessionKey ? [{ name: "lab-listener", key: sessionKey, subscriber: 0 }] : [], scrobbles: [] };
  const same = (left, right) => searchWords(left).join(" ") === searchWords(right).join(" ");
  const findArtist = (params) =>
    catalog.artists.find((artist) => artist.id === params.mbid || same(artist.name, params.artist));
  const images = (seed) =>
    ["small", "medium", "large", "extralarge", "mega"].map((size) => ({
      "#text": `${IMAGE_HOST}/i/u/300x300/${createHash("md5").update(`${seed}`).digest("hex")}.png`,
      size,
    }));
  const artistJson = (artist, extra = {}) => ({
    name: artist.name,
    mbid: artist.id,
    url: `https://www.last.fm/music/${encodeURIComponent(artist.name)}`,
    image: images(artist.id),
    ...extra,
  });
  const trackJson = (entry, extra = {}) => ({
    name: entry.title,
    mbid: stableUuid(`${entry.album.id}:recording:${entry.index + 1}`),
    url: `https://www.last.fm/music/${encodeURIComponent(entry.artist.name)}/_/${encodeURIComponent(entry.title)}`,
    duration: String(trackDurationSeconds(entry.index)),
    artist: { name: entry.artist.name, mbid: entry.artist.id, url: `https://www.last.fm/music/${encodeURIComponent(entry.artist.name)}` },
    image: images(entry.album.id),
    ...extra,
  });
  const ranked = (items) => items.map((item, index) => ({ ...item, "@attr": { rank: String(index + 1) } }));
  const plays = (index) => String(100000 - index * 1371);
  const fail = (status, code, message) => ({ status, body: { error: code, message } });

  const read = {
    "artist.getSimilar": (params) => {
      const artist = findArtist(params);
      if (!artist) return fail(404, 6, "The artist you supplied could not be found");
      const limit = Number(params.limit) || 100;
      return {
        similarartists: {
          artist: similarArtists(catalog, artist).slice(0, limit).map(({ artist: other, match }) => artistJson(other, { match: String(match) })),
          "@attr": { artist: artist.name },
        },
      };
    },
    "artist.getTopTags": (params) => {
      const artist = findArtist(params);
      if (!artist) return fail(404, 6, "The artist you supplied could not be found");
      return { toptags: { tag: artist.genres.map((name, index) => ({ name, count: 100 - index * 10, url: `https://www.last.fm/tag/${encodeURIComponent(name)}` })), "@attr": { artist: artist.name } } };
    },
    "artist.getTopTracks": (params) => {
      const artist = findArtist(params);
      if (!artist) return fail(404, 6, "The artist you supplied could not be found");
      const own = tracks.filter((entry) => entry.artist === artist);
      return { toptracks: { track: ranked(own.map((entry, index) => trackJson(entry, { playcount: plays(index), listeners: plays(index + 3) }))), "@attr": { artist: artist.name } } };
    },
    "chart.getTopArtists": () => ({
      artists: { artist: catalog.artists.map((artist, index) => artistJson(artist, { playcount: plays(index), listeners: plays(index + 2) })) },
    }),
    "chart.getTopTags": () => {
      const genres = [...new Set(catalog.artists.flatMap((artist) => artist.genres))];
      return { tags: { tag: genres.map((name, index) => ({ name, url: `https://www.last.fm/tag/${encodeURIComponent(name)}`, reach: plays(index), taggings: plays(index + 1) })) } };
    },
    "chart.getTopTracks": () => ({
      tracks: { track: tracks.map((entry, index) => trackJson(entry, { playcount: plays(index), listeners: plays(index + 1) })) },
    }),
    "tag.getTopArtists": (params) => ({
      topartists: { artist: ranked(catalog.artists.filter((artist) => artist.genres.some((genre) => same(genre, params.tag))).map((artist) => artistJson(artist))), "@attr": { tag: params.tag } },
    }),
    "tag.getTopTracks": (params) => ({
      tracks: { track: ranked(tracks.filter((entry) => entry.artist.genres.some((genre) => same(genre, params.tag))).map((entry) => trackJson(entry))), "@attr": { tag: params.tag } },
    }),
    "track.getInfo": (params) => {
      const entry = tracks.find((candidate) => same(candidate.artist.name, params.artist) && same(candidate.title, params.track))
        || tracks.find((candidate) => stableUuid(`${candidate.album.id}:recording:${candidate.index + 1}`) === params.mbid);
      if (!entry) return fail(404, 6, "Track not found");
      return {
        track: {
          ...trackJson(entry, { duration: String(trackDurationSeconds(entry.index) * 1000), listeners: plays(entry.index), playcount: plays(entry.index + 1) }),
          album: { artist: entry.artist.name, title: entry.album.title, mbid: entry.album.id, url: `https://www.last.fm/music/${encodeURIComponent(entry.artist.name)}/${encodeURIComponent(entry.album.title)}`, image: images(entry.album.id) },
          toptags: { tag: entry.artist.genres.map((name) => ({ name, url: `https://www.last.fm/tag/${encodeURIComponent(name)}` })) },
        },
      };
    },
    "album.getInfo": (params) => {
      const artist = findArtist(params);
      const album = artist?.albums.find((candidate) => candidate.id === params.mbid || same(candidate.title, params.album));
      if (!album) return fail(404, 6, "Album not found");
      return {
        album: {
          name: album.title,
          artist: artist.name,
          mbid: album.id,
          url: `https://www.last.fm/music/${encodeURIComponent(artist.name)}/${encodeURIComponent(album.title)}`,
          image: images(album.id),
          tags: { tag: artist.genres.map((name) => ({ name, url: `https://www.last.fm/tag/${encodeURIComponent(name)}` })) },
          tracks: { track: ranked(tracks.filter((entry) => entry.album === album).map((entry) => trackJson(entry))) },
        },
      };
    },
    "user.getTopArtists": (params) => {
      const limit = Number(params.limit) || 50;
      const artists = catalog.artists.slice(0, limit);
      return {
        topartists: {
          artist: ranked(artists.map((artist, index) => artistJson(artist, { playcount: String(400 - index * 37) }))),
          "@attr": { user: params.user, page: "1", perPage: String(limit), totalPages: "1", total: String(artists.length) },
        },
      };
    },
  };

  const signed = (params) => {
    const { api_sig: signature, format: _format, callback: _callback, ...rest } = params;
    const expected = createHash("md5")
      .update(`${Object.keys(rest).sort().map((key) => `${key}${rest[key]}`).join("")}${apiSecret}`)
      .digest("hex");
    return signature === expected;
  };
  const write = {
    "auth.getSession": (params) => {
      const token = state.tokens.find((entry) => entry.token === params.token && !entry.usedAt);
      if (!token) return fail(403, 4, "Unauthorized Token - This token has not been issued");
      token.usedAt = new Date().toISOString();
      const session = { name: "lab-listener", key: randomUUID().replaceAll("-", ""), subscriber: 0 };
      state.sessions.push(session);
      return { session };
    },
    "track.scrobble": (params) => {
      if (!state.sessions.some((session) => session.key === params.sk)) return fail(403, 9, "Invalid session key - Please re-authenticate");
      state.scrobbles.push({ artist: params.artist, track: params.track, album: params.album || null, timestamp: Number(params.timestamp), sessionKey: params.sk });
      return { scrobbles: { scrobble: { artist: { "#text": params.artist }, track: { "#text": params.track }, timestamp: params.timestamp }, "@attr": { accepted: 1, ignored: 0 } } };
    },
  };

  function station(username, kind) {
    const playlist = tracks
      .filter((_entry, index) => (kind === "library" ? index % 2 === 0 : kind === "mix" ? true : index % 2 === 1))
      .map((entry) => ({
        name: entry.title,
        mbid: stableUuid(`${entry.album.id}:recording:${entry.index + 1}`),
        duration: trackDurationSeconds(entry.index),
        artists: [{ name: entry.artist.name, mbid: entry.artist.id }],
        primary_album: { name: entry.album.title, mbid: entry.album.id },
      }));
    return { status: 200, body: { playlist, username } };
  }

  const handle = ({ method, url, host, body }) => {
    if (host === "lastfm.freetls.fastly.net") return { status: 200, raw: solidPng(url.pathname, 300), headers: { "content-type": "image/png" } };
    if (host === "www.last.fm") {
      if (method === "GET" && url.pathname.replace(/\/$/, "") === "/api/auth") {
        const callback = url.searchParams.get("cb");
        if (url.searchParams.get("api_key") !== apiKey || !callback) return { status: 400, body: "Invalid API key or callback" };
        const token = randomUUID().replaceAll("-", "");
        state.tokens.push({ token, issuedAt: new Date().toISOString() });
        const target = new URL(callback);
        target.searchParams.set("token", token);
        return { status: 302, headers: { location: target.href }, raw: "" };
      }
      const stationMatch = /^\/player\/station\/user\/([^/]+)\/(library|mix|recommended)$/.exec(url.pathname);
      if (method === "GET" && stationMatch) return station(decodeURIComponent(stationMatch[1]), stationMatch[2]);
      return null;
    }
    if (url.pathname !== "/2.0/" && url.pathname !== "/2.0") return null;
    const params = method === "POST" ? { ...(body || {}) } : Object.fromEntries(url.searchParams);
    if (params.api_key !== apiKey) return fail(403, 10, "Invalid API key - You must be granted a valid key by last.fm");
    if (method === "POST") {
      const handler = write[params.method];
      if (!handler) return fail(400, 3, "Invalid Method - No method with that name in this package");
      if (!signed(params)) return fail(403, 13, "Invalid method signature supplied");
      const result = handler(params);
      return result.status ? result : { status: 200, body: result };
    }
    const handler = read[params.method];
    if (!handler) return fail(400, 3, "Invalid Method - No method with that name in this package");
    const result = handler(params);
    return result.status ? result : { status: 200, body: result };
  };
  handle.state = state;
  handle.restore = (saved) => Object.assign(state, saved);
  return { name: "lastfm", hosts: ["ws.audioscrobbler.com", "www.last.fm", "lastfm.freetls.fastly.net"], handle };
}
