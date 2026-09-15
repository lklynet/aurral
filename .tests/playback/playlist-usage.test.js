import assert from "node:assert/strict";
import test from "node:test";
import { JellyfinClient } from "../../backend/services/jellyfin.js";
import { NavidromeClient } from "../../backend/services/navidrome.js";
import { PlexClient } from "../../backend/services/plex.js";
import { readPlaylistPages } from "../../backend/services/playback/playlistUsage.js";

test("Jellyfin checks private playlists for every user and paginates their tracks", async () => {
  const client = new JellyfinClient("http://jellyfin.local", "key", "admin");
  const reads = [];
  client.request = async (_method, endpoint, { params } = {}) => {
    reads.push([endpoint, params]);
    if (endpoint === "/Users") return [{ Id: "admin" }, { Id: "listener" }];
    if (endpoint === "/Items") return { Items: params.userId === "admin"
      ? [{ Id: "flow" }] : [{ Id: "saved" }], TotalRecordCount: 1 };
    assert.equal(params.userId, "listener");
    assert.equal(params.fields, "Path");
    return { Items: [{ Id: `track-${params.startIndex}`, Type: "Audio", Path: `/music/${params.startIndex}.flac` }], TotalRecordCount: 2 };
  };
  assert.deepEqual(await client.getPlaylistTrackPaths(new Set(["flow"])), ["/music/0.flac", "/music/1.flac"]);
  assert.equal(reads.filter(([endpoint]) => endpoint === "/Items").length, 2);
  assert.ok(reads.every(([endpoint]) => !endpoint.includes("/flow/")));
});

test("Jellyfin reads shared playlists for each user because library visibility can differ", async () => {
  const client = new JellyfinClient("http://jellyfin.local", "key", "admin");
  let contents = 0;
  client.request = async (_method, endpoint) => {
    if (endpoint === "/Users") return [{ Id: "admin" }, { Id: "listener" }];
    if (endpoint === "/Items") return { Items: [{ Id: "saved" }], TotalRecordCount: 1 };
    contents += 1;
    return { Items: [{ Path: `/music/saved-${contents}.flac` }], TotalRecordCount: 1 };
  };
  assert.deepEqual(await client.getPlaylistTrackPaths(), ["/music/saved-1.flac", "/music/saved-2.flac"]);
  assert.equal(contents, 2);
});

test("Jellyfin refuses incomplete listings and tracks without paths", async () => {
  const client = new JellyfinClient("http://jellyfin.local", "key", "admin");
  client.getUsers = async () => [{ Id: "admin" }];
  client.request = async () => ({ Items: [], TotalRecordCount: 1 });
  await assert.rejects(client.getPlaylistTrackPaths(), /Incomplete/);
  client.request = async (_method, endpoint) => endpoint === "/Items"
    ? { Items: [{ Id: "saved" }], TotalRecordCount: 1 }
    : { Items: [{ Id: "no-path" }], TotalRecordCount: 1 };
  await assert.rejects(client.getPlaylistTrackPaths(), /no file path/);
});

test("Navidrome protects relative playlist paths across library roots", async () => {
  const client = new NavidromeClient("http://navidrome.local", "admin", "password");
  client.request = async (endpoint, params) => {
    if (endpoint === "getUser") return { user: { adminRole: true } };
    if (endpoint === "getPlaylists") return { playlists: { playlist: [{ id: "flow" }, { id: "saved" }] } };
    assert.equal(params.id, "saved");
    return { playlist: { songCount: 2, entry: [
      { path: "Artist/Track.flac" }, { path: "/other/Track.mp3" },
    ] } };
  };
  client.getLibraries = async () => [{ path: "/music" }, { path: "/archive" }];
  assert.deepEqual(await client.getPlaylistTrackPaths(new Set(["flow"])), [
    "/music/Artist/Track.flac", "/archive/Artist/Track.flac", "/other/Track.mp3",
  ]);
});

for (const singletonPlaylist of [false, true]) {
  for (const singletonEntry of [false, true]) {
    test(`Navidrome accepts ${singletonPlaylist ? "singleton" : "array"} playlists with ${singletonEntry ? "singleton" : "array"} entries`, async () => {
      const client = new NavidromeClient("http://navidrome.local", "admin", "password");
      const playlist = { id: "saved" };
      const entry = { path: "Artist/Track.flac" };
      let detailReads = 0;
      client.request = async (endpoint, params) => {
        if (endpoint === "getUser") return { user: { adminRole: true } };
        if (endpoint === "getPlaylists") return { playlists: {
          playlist: singletonPlaylist ? playlist : [playlist],
        } };
        assert.equal(endpoint, "getPlaylist");
        assert.equal(params.id, "saved");
        detailReads += 1;
        return { playlist: { songCount: 1, entry: singletonEntry ? entry : [entry] } };
      };
      client.getLibraries = async () => [{ path: "/music" }];
      assert.deepEqual(await client.getPlaylistTrackPaths(), ["/music/Artist/Track.flac"]);
      assert.deepEqual(await client.getPlaylistTrackPaths(new Set(["saved"])), []);
      assert.equal(detailReads, 1);
    });
  }
}

test("Navidrome accepts empty collections but still rejects malformed and truncated singleton responses", async () => {
  const client = new NavidromeClient("http://navidrome.local", "admin", "password");
  let playlists = {};
  let detail = { songCount: 0 };
  client.request = async (endpoint) => {
    if (endpoint === "getUser") return { user: { adminRole: true } };
    if (endpoint === "getPlaylists") return { playlists };
    return { playlist: detail };
  };
  assert.deepEqual(await client.getPlaylistTrackPaths(), []);
  playlists = { playlist: { id: "saved" } };
  assert.deepEqual(await client.getPlaylistTrackPaths(), []);
  detail = { songCount: 2, entry: { path: "/music/Track.flac" } };
  await assert.rejects(client.getPlaylistTrackPaths(), /Incomplete/);
  detail = { songCount: 1, entry: "invalid" };
  await assert.rejects(client.getPlaylistTrackPaths(), /no file path/);
  playlists = { playlist: "invalid" };
  await assert.rejects(client.getPlaylistTrackPaths(), /missing its ID/);
  playlists = null;
  await assert.rejects(client.getPlaylistTrackPaths(), /Invalid/);
});

test("Navidrome refuses limited playlist visibility", async () => {
  const client = new NavidromeClient("http://navidrome.local", "listener", "password");
  client.request = async () => ({ user: { adminRole: false } });
  await assert.rejects(client.getPlaylistTrackPaths(), /admin account/);
});

test("Navidrome refuses truncated or malformed playlists", async () => {
  const client = new NavidromeClient("http://navidrome.local", "admin", "password");
  client.request = async (endpoint) => {
    if (endpoint === "getUser") return { user: { adminRole: true } };
    if (endpoint === "getPlaylists") return { playlists: { playlist: [{ id: "saved" }] } };
    return { playlist: { songCount: 1, entry: [] } };
  };
  await assert.rejects(client.getPlaylistTrackPaths(), /Incomplete/);
});

test("Plex paginates playlists and includes all file parts in smart playlists", async () => {
  const client = new PlexClient("http://plex.local", "token", "client");
  const reads = [];
  client.request = async (endpoint, { params }) => {
    reads.push(endpoint);
    const offset = params["X-Plex-Container-Start"];
    if (endpoint === "/playlists") return { MediaContainer: { totalSize: 2, Metadata: [
      offset === 0 ? { ratingKey: "flow" } : { ratingKey: "saved", smart: true },
    ] } };
    assert.equal(endpoint, "/playlists/saved/items");
    return { MediaContainer: { totalSize: 2, Metadata: [{ ratingKey: `track-${offset}`, Media: [
      { Part: [{ file: `/music/${offset}.flac` }, { file: `/mirror/${offset}.flac` }] },
    ] }] } };
  };
  assert.deepEqual(await client.getPlaylistTrackPaths(new Set(["flow"])), [
    "/music/0.flac", "/mirror/0.flac", "/music/1.flac", "/mirror/1.flac",
  ]);
  assert.equal(reads.length, 4);
});

test("Plex refuses missing media metadata and incomplete pages", async () => {
  const client = new PlexClient("http://plex.local", "token", "client");
  client.request = async () => ({ MediaContainer: { size: 0, totalSize: 1 } });
  await assert.rejects(client.getPlaylistTrackPaths(), /Incomplete/);
  client.request = async (endpoint) => ({ MediaContainer: { totalSize: 1, Metadata: [
    endpoint === "/playlists" ? { ratingKey: "saved" } : { ratingKey: "track" },
  ] } });
  await assert.rejects(client.getPlaylistTrackPaths(), /no media path/);
});

for (const Client of [JellyfinClient, NavidromeClient, PlexClient]) {
  test(`${Client.name} propagates service outages rather than reporting no references`, async () => {
    const client = new Client("http://service.local", "user", "secret");
    client.request = async () => { throw new Error("offline"); };
    await assert.rejects(client.getPlaylistTrackPaths(), /offline/);
  });
}

test("usage pagination rejects repeated pages and malformed totals", async () => {
  await assert.rejects(readPlaylistPages(async () => ({ items: [{ id: "track" }] })), /did not advance/);
  await assert.rejects(readPlaylistPages(async () => ({ items: [], total: "3" })), /Invalid/);
});

test("usage pagination rejects a page that exceeds its declared total", async () => {
  await assert.rejects(readPlaylistPages(async () => ({
    items: [{ id: "a" }], total: 0,
  })), /exceeds its declared total/);
  await assert.rejects(readPlaylistPages(async (start) => ({
    items: start === 0 ? [{ id: "a" }] : [{ id: "b" }, { id: "c" }], total: 2,
  })), /exceeds its declared total/);
  assert.deepEqual(await readPlaylistPages(async () => ({
    items: [{ id: "a" }], total: 1,
  })), [{ id: "a" }]);
});
