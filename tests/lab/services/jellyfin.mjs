import { createHash } from "node:crypto";
import fs from "node:fs";

const guid = (seed) => createHash("sha1").update(seed).digest("hex").slice(0, 32);

export const jellyfinUserId = (username) => guid(`jellyfin-user:${username}`);

export function createJellyfin({ media, apiKey, username }) {
  const user = { Id: jellyfinUserId(username), Name: username, Policy: { IsAdministrator: true }, HasPassword: true };
  const state = { playlists: [], refreshes: 0, nextEntry: 1 };

  const tokenOf = (headers, url) =>
    /Token="([^"]*)"/.exec(String(headers.authorization || headers["x-emby-authorization"] || ""))?.[1] ||
    headers["x-emby-token"] ||
    headers["x-mediabrowser-token"] ||
    url.searchParams.get("api_key") ||
    url.searchParams.get("ApiKey");

  const audio = (song, extra = {}) => ({
    Id: guid(`jellyfin-audio:${song.path}`),
    Name: song.title,
    Type: "Audio",
    MediaType: "Audio",
    Path: song.path,
    Album: song.album,
    AlbumArtist: song.albumArtist,
    Artists: [song.artist],
    IndexNumber: song.track,
    RunTimeTicks: song.duration * 10_000_000,
    ProviderIds: song.musicBrainzId ? { MusicBrainzTrack: song.musicBrainzId } : {},
    ...extra,
  });
  const songById = (id) => media.songs().find((song) => guid(`jellyfin-audio:${song.path}`) === id);
  const playlistJson = (playlist) => ({
    Id: playlist.Id,
    Name: playlist.Name,
    Type: "Playlist",
    MediaType: "Audio",
    IsFolder: true,
    ChildCount: playlist.entries.length,
    Path: `/config/data/playlists/${playlist.Name}/playlist.xml`,
  });
  const pageOf = (items, url) => {
    const start = Number(url.searchParams.get("startIndex") || url.searchParams.get("StartIndex") || 0);
    const limit = Number(url.searchParams.get("limit") || url.searchParams.get("Limit") || items.length || 1);
    return { status: 200, body: { Items: items.slice(start, start + limit), TotalRecordCount: items.length, StartIndex: start } };
  };
  const noContent = { status: 204 };

  const handler = ({ method, url, headers, body }) => {
    if (tokenOf(headers, url) !== apiKey) return { status: 401, body: "Unauthorized" };
    const parts = url.pathname.split("/").filter(Boolean);
    const lower = parts.map((part) => part.toLowerCase());
    const query = url.searchParams;
    const playlist = (id) => state.playlists.find((entry) => entry.Id === id);

    if (method === "GET" && url.pathname === "/System/Info") {
      return { status: 200, body: { ServerName: "Aurral Lab Jellyfin", Version: "10.10.0", Id: guid("jellyfin-server"), OperatingSystem: "Linux" } };
    }
    if (method === "GET" && lower[0] === "users" && !parts[1]) return { status: 200, body: [user] };
    if (method === "GET" && lower[0] === "users" && parts[1] && !parts[2]) {
      return parts[1] === user.Id ? { status: 200, body: user } : { status: 404, body: "User not found" };
    }
    if (method === "POST" && url.pathname === "/Library/Refresh") {
      media.scan();
      state.refreshes += 1;
      return noContent;
    }
    if (lower[0] === "items" && !parts[1] && method === "GET") {
      const types = String(query.get("includeItemTypes") || query.get("IncludeItemTypes") || "").split(",");
      if (types.includes("Playlist")) return pageOf(state.playlists.map(playlistJson), url);
      return pageOf(media.songs().map((song) => audio(song)), url);
    }
    const itemId = lower[0] === "users" && lower[2] === "items" ? parts[3] : lower[0] === "items" ? parts[1] : null;
    if (itemId) {
      const target = playlist(itemId);
      const song = !target && songById(itemId);
      if (method === "GET") {
        if (target) return { status: 200, body: playlistJson(target) };
        if (song) return { status: 200, body: audio(song) };
        return { status: 404, body: "Item not found" };
      }
      if (method === "POST" && target) {
        if (body?.Name) target.Name = body.Name;
        return noContent;
      }
      if (method === "DELETE" && target) {
        state.playlists = state.playlists.filter((entry) => entry !== target);
        return noContent;
      }
      if (method === "GET" && lower[2] === "download" && song) return { status: 200, raw: fs.readFileSync(song.path) };
    }
    if (lower[0] === "playlists" && !parts[1] && method === "POST") {
      const created = {
        Id: guid(`jellyfin-playlist:${body?.Name}:${Date.now()}:${state.playlists.length}`),
        Name: String(body?.Name || "Playlist"),
        UserId: body?.UserId || user.Id,
        entries: (body?.Ids || []).map((id) => ({ Id: id, PlaylistItemId: String(state.nextEntry++) })),
      };
      state.playlists.push(created);
      return { status: 200, body: { Id: created.Id } };
    }
    if (lower[0] === "playlists" && parts[1] && lower[2] === "items") {
      const target = playlist(parts[1]);
      if (!target) return { status: 404, body: "Playlist not found" };
      if (method === "GET") {
        const items = target.entries
          .map((entry) => {
            const song = songById(entry.Id);
            return song && audio(song, { PlaylistItemId: entry.PlaylistItemId });
          })
          .filter(Boolean);
        return pageOf(items, url);
      }
      if (method === "POST") {
        for (const id of String(query.get("ids") || query.get("Ids") || "").split(",").filter(Boolean)) {
          target.entries.push({ Id: id, PlaylistItemId: String(state.nextEntry++) });
        }
        return noContent;
      }
      if (method === "DELETE") {
        const removed = new Set(String(query.get("entryIds") || query.get("EntryIds") || "").split(",").filter(Boolean));
        target.entries = target.entries.filter((entry) => !removed.has(entry.PlaylistItemId));
        return noContent;
      }
    }
    return null;
  };
  handler.state = state;
  handler.restore = (saved) => Object.assign(state, saved);
  handler.userId = user.Id;
  return handler;
}
