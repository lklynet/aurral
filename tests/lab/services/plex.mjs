import fs from "node:fs";
import { numericId } from "./runtime.mjs";

export function createPlex({ mediaRoot, media, token, machineIdentifier }) {
  const state = {
    sections: [{ key: "1", title: "Music", type: "artist", agent: "tv.plex.agents.music", scanner: "Plex Music", locations: [mediaRoot] }],
    playlists: [],
    nextSectionKey: 2,
    nextPlaylistKey: 900001,
    nextPlaylistItemId: 1,
    refreshes: 0,
  };

  const ratingKey = (song) => String(numericId(`plex:${song.path}`));
  const songByKey = (key) => media.songs().find((song) => ratingKey(song) === String(key));
  const ok = (MediaContainer = {}) => ({ status: 200, body: { MediaContainer } });

  const track = (song, extra = {}) => ({
    ratingKey: ratingKey(song),
    key: `/library/metadata/${ratingKey(song)}`,
    type: "track",
    title: song.title,
    grandparentTitle: song.artist,
    originalTitle: song.artist,
    parentTitle: song.album,
    index: song.track,
    duration: song.duration * 1000,
    Media: [{ id: Number(ratingKey(song)), duration: song.duration * 1000, audioCodec: song.suffix, Part: [{ id: Number(ratingKey(song)), key: `/library/parts/${ratingKey(song)}/file.${song.suffix}`, file: song.path, size: song.size }] }],
    ...extra,
  });

  const section = (entry) => ({
    key: entry.key,
    title: entry.title,
    type: entry.type,
    agent: entry.agent,
    scanner: entry.scanner,
    language: "en-US",
    Location: entry.locations.map((location, index) => ({ id: Number(entry.key) * 100 + index, path: location })),
  });

  const songsIn = (entry) =>
    media.songs().filter((song) => entry.locations.some((location) => song.path === location || song.path.startsWith(`${location.replace(/\/+$/, "")}/`)));

  const page = (items, url) => {
    const start = Number(url.searchParams.get("X-Plex-Container-Start") || 0);
    const size = Number(url.searchParams.get("X-Plex-Container-Size") || items.length || 1);
    const slice = items.slice(start, start + size);
    return ok({ size: slice.length, totalSize: items.length, offset: start, Metadata: slice });
  };

  const playlistJson = (playlist) => ({
    ratingKey: playlist.ratingKey,
    key: `/playlists/${playlist.ratingKey}/items`,
    type: "playlist",
    title: playlist.title,
    summary: playlist.summary || "",
    smart: false,
    playlistType: "audio",
    leafCount: playlist.items.length,
    duration: playlist.items.reduce((total, item) => total + (songByKey(item.ratingKey)?.duration || 0) * 1000, 0),
  });

  const keysFromUri = (uri) => {
    const match = /\/library\/metadata\/([\d,]+)/.exec(String(uri || ""));
    return match ? match[1].split(",").filter(Boolean) : [];
  };

  const handler = ({ method, url, headers }) => {
    if (headers["x-plex-token"] !== token && url.searchParams.get("X-Plex-Token") !== token) {
      return { status: 401, body: "Unauthorized" };
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const params = url.searchParams;

    if (method === "GET" && url.pathname === "/identity") {
      return ok({ machineIdentifier, version: "1.41.0.0-lab", claimed: true, size: 0 });
    }
    if (method === "GET" && url.pathname === "/") {
      return ok({ machineIdentifier, version: "1.41.0.0-lab", friendlyName: "Aurral Lab Plex", myPlex: true });
    }
    if (parts[0] === "library" && parts[1] === "sections") {
      const target = parts[2] && state.sections.find((entry) => entry.key === parts[2]);
      if (!parts[2] && method === "GET") return ok({ size: state.sections.length, Directory: state.sections.map(section) });
      if (!parts[2] && method === "POST") {
        const created = {
          key: String(state.nextSectionKey++),
          title: params.get("name") || "Music",
          type: "artist",
          agent: params.get("agent") || "tv.plex.agents.music",
          scanner: params.get("scanner") || "Plex Music",
          locations: params.getAll("location").map((location) => location.replace(/\/+$/, "")),
        };
        if (created.locations.some((location) => !fs.existsSync(location))) return { status: 400, body: "Location is not available" };
        state.sections.push(created);
        return ok({ size: 1, Directory: [section(created)] });
      }
      if (!target) return { status: 404, body: "Section not found" };
      if (parts[3] === "refresh") {
        media.scan();
        state.refreshes += 1;
        return ok();
      }
      if (parts[3] === "all" && method === "GET") return page(songsIn(target).map((song) => track(song)), url);
      if (!parts[3] && method === "PUT") {
        if (params.get("name")) target.title = params.get("name");
        if (params.getAll("location").length) target.locations = params.getAll("location").map((location) => location.replace(/\/+$/, ""));
        return ok();
      }
      if (!parts[3] && method === "DELETE") {
        state.sections = state.sections.filter((entry) => entry !== target);
        return ok();
      }
    }
    if (parts[0] === "library" && parts[1] === "metadata" && parts[2] && method === "GET") {
      const song = songByKey(parts[2]);
      return song ? ok({ size: 1, Metadata: [track(song)] }) : { status: 404, body: "Not found" };
    }
    if (parts[0] === "library" && parts[1] === "parts" && parts[2] && method === "GET") {
      const song = songByKey(parts[2]);
      return song ? { status: 200, raw: fs.readFileSync(song.path), headers: { "content-type": song.contentType } } : { status: 404, body: "Not found" };
    }
    if (parts[0] === "playlists") {
      const playlist = parts[1] && state.playlists.find((entry) => entry.ratingKey === parts[1]);
      if (!parts[1] && method === "GET") return page(state.playlists.map(playlistJson), url);
      if (!parts[1] && method === "POST") {
        const created = {
          ratingKey: String(state.nextPlaylistKey++),
          title: params.get("title") || "Playlist",
          summary: "",
          items: keysFromUri(params.get("uri")).map((key) => ({ ratingKey: key, playlistItemID: state.nextPlaylistItemId++ })),
        };
        state.playlists.push(created);
        return ok({ size: 1, Metadata: [playlistJson(created)] });
      }
      if (!playlist) return { status: 404, body: "Playlist not found" };
      if (parts[2] === "items" && !parts[3] && method === "GET") {
        const items = playlist.items
          .map((item) => {
            const song = songByKey(item.ratingKey);
            return song && track(song, { playlistItemID: item.playlistItemID });
          })
          .filter(Boolean);
        return page(items, url);
      }
      if (parts[2] === "items" && !parts[3] && method === "PUT") {
        for (const key of keysFromUri(params.get("uri"))) playlist.items.push({ ratingKey: key, playlistItemID: state.nextPlaylistItemId++ });
        return ok({ size: 1, Metadata: [playlistJson(playlist)] });
      }
      if (parts[2] === "items" && parts[3] && method === "DELETE") {
        playlist.items = playlist.items.filter((item) => String(item.playlistItemID) !== parts[3]);
        return ok({ size: 1, Metadata: [playlistJson(playlist)] });
      }
      if (!parts[2] && method === "PUT") {
        if (params.has("title")) playlist.title = params.get("title");
        if (params.has("summary")) playlist.summary = params.get("summary");
        return ok();
      }
      if (!parts[2] && method === "DELETE") {
        state.playlists = state.playlists.filter((entry) => entry !== playlist);
        return ok();
      }
      if (!parts[2] && method === "GET") return ok({ size: 1, Metadata: [playlistJson(playlist)] });
    }
    return null;
  };
  handler.state = state;
  handler.restore = (saved) => Object.assign(state, saved);
  return handler;
}
