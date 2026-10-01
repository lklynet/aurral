import { createHash, randomUUID } from "node:crypto";
import { catalogTracks } from "../runtime.mjs";

const PAGE_LIMIT_MAX = 50;

export function createSpotify(catalog, { clientId, redirectUri, refreshToken }) {
  const tracks = catalogTracks(catalog);
  const state = { codes: [], tokens: refreshToken ? [{ accessToken: null, refreshToken, expiresAt: 0 }] : [] };
  const spotifyId = (seed) => createHash("sha1").update(`spotify:${seed}`).digest("base64url").slice(0, 22);
  const playlists = [
    { id: spotifyId("road-trip"), name: "Lab Road Trip", picks: (index) => index % 2 === 0 },
    { id: spotifyId("late-night"), name: "Lab Late Night", picks: (index) => index % 3 !== 0 },
    { id: spotifyId("long-mix"), name: "Lab Long Mix", repeat: 3, picks: () => true },
    ...catalog.artists.map((artist) => ({ id: spotifyId(`this-is:${artist.id}`), name: `This Is ${artist.name}`, picks: (_index, entry) => entry.artist === artist })),
  ].map((playlist) => {
    const entries = tracks.filter((entry, index) => playlist.picks(index, entry));
    return { ...playlist, entries: Array.from({ length: playlist.repeat || 1 }, () => entries).flat() };
  });
  const issue = () => {
    const token = { accessToken: randomUUID().replaceAll("-", ""), refreshToken: randomUUID().replaceAll("-", ""), expiresAt: Date.now() + 3600_000 };
    state.tokens.push(token);
    return token;
  };
  const redirect = (location) => ({ status: 302, headers: { location }, raw: "" });
  const page = (url, items, map) => {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 20, PAGE_LIMIT_MAX);
    const offset = Number(url.searchParams.get("offset")) || 0;
    const next = offset + limit < items.length ? new URL(url) : null;
    if (next) next.searchParams.set("offset", String(offset + limit));
    return { status: 200, body: { href: `https://api.spotify.com${url.pathname}${url.search}`, limit, offset, total: items.length, next: next && `https://api.spotify.com${next.pathname}${next.search}`, items: items.slice(offset, offset + limit).map(map) } };
  };

  const handle = ({ method, url, host, headers }) => {
    if (method !== "GET") return null;
    if (host === "accounts.spotify.com" && url.pathname === "/authorize") {
      if (url.searchParams.get("client_id") !== clientId || url.searchParams.get("redirect_uri") !== redirectUri) {
        return { status: 400, body: "INVALID_CLIENT: Invalid redirect URI" };
      }
      const code = randomUUID();
      state.codes.push({ code, issuedAt: Date.now() });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state") || "");
      return redirect(target.href);
    }
    if (host === "spotify.lidarr.audio" && url.pathname === "/auth") {
      const code = state.codes.find((entry) => entry.code === url.searchParams.get("code") && !entry.usedAt);
      if (!code) return { status: 400, body: "Invalid authorization code" };
      code.usedAt = Date.now();
      const token = issue();
      const target = new URL(url.searchParams.get("state"));
      target.searchParams.set("access_token", token.accessToken);
      target.searchParams.set("refresh_token", token.refreshToken);
      target.searchParams.set("expires_in", "3600");
      return redirect(target.href);
    }
    if (host === "spotify.lidarr.audio" && url.pathname === "/renew") {
      const previous = state.tokens.find((entry) => entry.refreshToken === url.searchParams.get("refresh_token"));
      if (!previous) return { status: 401, body: { error: "invalid_grant" } };
      previous.accessToken = randomUUID().replaceAll("-", "");
      previous.expiresAt = Date.now() + 3600_000;
      return { status: 200, body: { access_token: previous.accessToken, expires_in: 3600 } };
    }
    if (host !== "api.spotify.com") return null;
    const bearer = String(headers.authorization || "").replace(/^Bearer /, "");
    const token = state.tokens.find((entry) => entry.accessToken === bearer);
    if (!token || token.expiresAt < Date.now()) return { status: 401, body: { error: { status: 401, message: "The access token expired" } } };
    if (url.pathname === "/v1/me") return { status: 200, body: { id: "lab-listener", display_name: "Lab Listener", type: "user" } };
    if (url.pathname === "/v1/me/playlists") {
      return page(url, playlists, (playlist) => ({ id: playlist.id, name: playlist.name, owner: { id: "lab-listener" }, items: { total: playlist.entries.length }, type: "playlist" }));
    }
    const items = /^\/v1\/playlists\/([^/]+)\/items$/.exec(url.pathname);
    const playlist = items && playlists.find((entry) => entry.id === decodeURIComponent(items[1]));
    if (items && !playlist) return { status: 404, body: { error: { status: 404, message: "Resource not found" } } };
    if (playlist) {
      return page(url, playlist.entries, (entry) => ({ item: { type: "track", name: entry.title, artists: [{ name: entry.artist.name }], album: { name: entry.album.title } } }));
    }
    return null;
  };
  handle.state = state;
  handle.restore = (saved) => Object.assign(state, saved);
  return { name: "spotify", hosts: ["accounts.spotify.com", "spotify.lidarr.audio", "api.spotify.com"], handle };
}
