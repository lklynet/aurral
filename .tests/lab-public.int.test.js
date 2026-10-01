import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { cleanupIsolatedState, setupIsolatedBackend } from "./helpers/backendTestHarness.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const labDir = join(repoRoot, "tests", "lab");
const labEnv = parseEnv(readFileSync(join(labDir, "lab.env"), "utf8"));
const catalog = JSON.parse(readFileSync(join(labDir, "fixtures", "catalog.json"), "utf8"));
const LISTENERS = ["brainzmash", "lidarr", "slskd", "prowlarr", "sabnzbd", "nzbget", "deemix", "navidrome", "plex", "jellyfin", "koito", "notify", "public-http", "public-tls", "control"];

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const workDir = mkdtempSync(join(tmpdir(), "aurral-lab-public-"));
mkdirSync(join(workDir, "media"));
const ports = {};
for (const name of LISTENERS) ports[name] = await freePort();
const fixtures = spawn(process.execPath, [join(labDir, "services", "server.mjs")], {
  env: {
    PATH: process.env.PATH,
    ...labEnv,
    AURRAL_LAB_PORTS: JSON.stringify(ports),
    AURRAL_LAB_MEDIA_ROOT: join(workDir, "media"),
    AURRAL_LAB_TLS_DIR: join(workDir, "tls"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const control = `http://127.0.0.1:${ports.control}`;
for (const deadline = Date.now() + 15000; ; ) {
  if (fixtures.exitCode !== null) throw new Error("The fixtures service exited during startup.");
  try {
    if ((await fetch(`${control}/health`)).ok) break;
  } catch {}
  if (Date.now() > deadline) throw new Error("The fixtures service did not start.");
  await new Promise((resolve) => setTimeout(resolve, 100));
}

process.env.AURRAL_LAB_PUBLIC_TLS = `localhost:${ports["public-tls"]}`;
process.env.AURRAL_LAB_PUBLIC_HTTP = `127.0.0.1:${ports["public-http"]}`;
process.env.AURRAL_LAB_REDIRECTS = JSON.stringify({
  [new URL(labEnv.AURRAL_LAB_PLEX_URL).host]: `127.0.0.1:${ports.plex}`,
  [new URL(labEnv.AURRAL_LAB_GOTIFY_URL).host]: `127.0.0.1:${ports.notify}`,
});
await import(pathToFileURL(join(labDir, "egress.mjs")).href);
tls.setDefaultCACertificates([...tls.getCACertificates("default"), readFileSync(join(workDir, "tls", "ca.pem"), "utf8")]);

const [
  paths,
  { dbOps, userOps },
  deezer,
  { musicbrainzGetArtistAppearsOnReleaseGroups },
  { lastfmRequest, lastfmGetSession, lastfmScrobble },
  { listenbrainzValidateToken, listenbrainzSubmit },
  { listenbrainzPlaylistClient },
  { lastfmStationClient },
  { scrobbleConnectionStore },
  { spotifyClient },
  { spotifyConnectionStore },
  { getNearbyShows },
  { fetchRssFeed, fetchArticleImage },
  { DEFAULT_NEWS_FEEDS },
  { fetchImageBuffer },
  { warmImageProxy },
  { resolvePlaylistSourceImageUrl },
  { PlexClient },
  google,
  oidc,
  { sendGotifyTest, sendWebhookTest },
] = await setupIsolatedBackend(
  "lab-public",
  "backend/db/helpers/index.js",
  "backend/services/apiClients/deezer.js",
  "backend/services/apiClients/musicbrainz.js",
  "backend/services/apiClients/lastfm.js",
  "backend/services/apiClients/listenbrainz.js",
  "backend/services/importLists/listenbrainzPlaylists.js",
  "backend/services/importLists/lastfmStations.js",
  "backend/services/scrobbleConnectionStore.js",
  "backend/services/spotify/spotifyClient.js",
  "backend/services/spotify/spotifyConnectionStore.js",
  "backend/services/nearbyShowsService.js",
  "backend/services/rssNews.js",
  "backend/services/apiClients/config.js",
  "backend/services/discovery/stylizedArtwork.js",
  "backend/services/imageProxyService.js",
  "backend/services/playlistArtworkGenerator.js",
  "backend/services/plex.js",
  "backend/services/googleAuth.js",
  "backend/services/oidcAuth.js",
  "backend/services/notificationService.js",
);
test.after(() => {
  fixtures.kill();
  cleanupIsolatedState(paths);
  rmSync(workDir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const fixtureState = async (name) => (await fetch(`${control}/state/${name}`)).json();
const configure = (integrations) => {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { ...settings.integrations, ...integrations } });
};
let userCount = 0;
const createUser = () => userOps.createUser(`lab-public-${++userCount}`, "unused-hash", "user");
const redirectTarget = async (url) => {
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 302, `${url} did not redirect`);
  return new URL(response.headers.get("location"));
};
const approveSignIn = async (authorizeUrl, accountIndex = 0) => {
  const page = await fetch(authorizeUrl);
  assert.equal(page.status, 200);
  const links = [...(await page.text()).matchAll(/href="([^"]+)"/g)].map((match) => match[1].replaceAll("&amp;", "&"));
  return redirectTarget(new URL(links[accountIndex], authorizeUrl));
};
const fakeResponse = () => ({
  headers: {},
  redirect(_status, location) {
    this.location = location;
  },
  setHeader(name, value) {
    this.headers[name] = value;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(value) {
    this.body = value;
  },
});

test("Deezer search, artwork, albums, tracks, and previews resolve for every catalog artist", async () => {
  for (const entry of catalog.artists) {
    const artist = await deezer.getDeezerArtist(entry.name);
    assert.equal(artist?.name, entry.name);
    const proxied = await warmImageProxy(artist.imageUrl);
    assert.ok(existsSync(proxied.imagePath), `the image proxy did not cache ${entry.name}'s artwork`);

    const albums = await deezer.getDeezerAlbumsForArtist(artist);
    assert.deepEqual(albums.map((album) => album.title).sort(), entry.albums.map((album) => album.title).sort());
    const tracks = await deezer.deezerGetAlbumTracks(albums.find((album) => album.title === entry.albums[0].title).id);
    assert.deepEqual(tracks.map((track) => track.title), entry.albums[0].tracks);

    const [top] = await deezer.deezerGetArtistTopTracks(entry.name);
    const preview = await fetch(top.preview_url);
    assert.equal(preview.headers.get("content-type"), "audio/mpeg");
    assert.ok((await preview.arrayBuffer()).byteLength > 1000);
  }
  const single = await deezer.deezerGetTrackPreview({ artistName: catalog.artists[0].name, trackName: catalog.artists[0].albums[0].tracks[1] });
  assert.ok(single?.preview_url);
});

test("MusicBrainz recording search finds compilations each artist appears on", async () => {
  const [entry] = catalog.artists;
  const appearsOn = await musicbrainzGetArtistAppearsOnReleaseGroups(entry.id, entry.albums.map((album) => ({ id: album.id })));
  assert.equal(appearsOn.length, 1);
  assert.ok(appearsOn[0]["secondary-types"].includes("Compilation"));
  assert.ok(!entry.albums.some((album) => album.id === appearsOn[0].id));
});

test("Last.fm answers discovery calls, links an account through its sign-in redirect, and records scrobbles", async () => {
  configure({ lastfm: { ...dbOps.getSettings().integrations.lastfm, apiKey: labEnv.AURRAL_LAB_LASTFM_API_KEY, apiSecret: labEnv.AURRAL_LAB_LASTFM_API_SECRET } });
  const [entry] = catalog.artists;
  const similar = await lastfmRequest("artist.getSimilar", { artist: entry.name, limit: 5 });
  assert.ok(similar.similarartists.artist.length > 0);
  assert.ok(similar.similarartists.artist.every((artist) => artist.name !== entry.name && artist.mbid));
  const tags = await lastfmRequest("chart.getTopTags", { limit: 100 });
  const tagged = await lastfmRequest("tag.getTopArtists", { tag: tags.tags.tag[0].name });
  assert.ok(tagged.topartists.artist.length > 0);

  const callback = await redirectTarget(
    `https://www.last.fm/api/auth/?api_key=${labEnv.AURRAL_LAB_LASTFM_API_KEY}&cb=${encodeURIComponent("http://127.0.0.1:3001/api/scrobbling/lastfm/link/callback?uid=state")}`,
  );
  assert.equal(callback.searchParams.get("uid"), "state");
  const session = await lastfmGetSession(callback.searchParams.get("token"));
  await assert.rejects(lastfmGetSession(callback.searchParams.get("token")), (error) => error.response?.status === 403);

  const before = (await fixtureState("lastfm")).scrobbles.length;
  await lastfmScrobble({ artist: entry.name, title: entry.albums[0].tracks[0], album: entry.albums[0].title, playedAt: Date.now() }, session.session.key);
  await assert.rejects(lastfmScrobble({ artist: entry.name, title: "x", playedAt: Date.now() }, "not-a-session"), (error) => error.response?.status === 403);
  const scrobbles = (await fixtureState("lastfm")).scrobbles;
  assert.equal(scrobbles.length, before + 1);
  assert.equal(scrobbles.at(-1).track, entry.albums[0].tracks[0]);

  const user = createUser();
  const stations = await lastfmStationClient.listPlaylists(user.id, "lab-listener");
  assert.ok(stations.playlists.every((station) => station.trackCount > 0));
});

test("ListenBrainz validates tokens, lists generated and personal playlists, and accepts listens", async () => {
  assert.equal((await listenbrainzValidateToken("wrong-token")).valid, false);
  const validation = await listenbrainzValidateToken(labEnv.AURRAL_LAB_LISTENBRAINZ_TOKEN);
  assert.equal(validation.valid, true);

  const user = createUser();
  scrobbleConnectionStore.saveConnection(user.id, "listenbrainz", { token: labEnv.AURRAL_LAB_LISTENBRAINZ_TOKEN, displayName: validation.user_name });
  const { playlists } = await listenbrainzPlaylistClient.listPlaylists(user.id);
  assert.ok(playlists.some((playlist) => !playlist.sourceType && playlist.trackCount > 0));
  assert.deepEqual(playlists.filter((playlist) => playlist.sourceType).map((playlist) => playlist.sourceType).sort(), ["weekly-exploration", "weekly-jams"]);
  const jams = await listenbrainzPlaylistClient.getGeneratedPlaylistTracks(user.id, "weekly-jams");
  assert.ok(jams.tracks.length > 0);
  assert.ok(jams.tracks.every((track) => track.artistName && track.trackName && track.trackMbid));

  const before = (await fixtureState("listenbrainz")).listens.length;
  await listenbrainzSubmit({ token: labEnv.AURRAL_LAB_LISTENBRAINZ_TOKEN, event: { artist: "Portishead", title: "Roads", playedAt: Date.now() } });
  assert.equal((await fixtureState("listenbrainz")).listens.length, before + 1);
});

test("Spotify renews an expired connection and pages through long playlists", async () => {
  const user = createUser();
  spotifyConnectionStore.saveConnection(user.id, {
    accessToken: "expired",
    refreshToken: labEnv.AURRAL_LAB_SPOTIFY_REFRESH_TOKEN,
    expiresAt: 1,
    displayName: "Lab Listener",
  });
  const { playlists } = await spotifyClient.listPlaylists(user.id);
  assert.notEqual(spotifyConnectionStore.getConnection(user.id).accessToken, "expired");
  const longest = playlists.reduce((best, playlist) => (playlist.trackCount > best.trackCount ? playlist : best));
  assert.ok(longest.trackCount > 50, "the Lab needs a playlist that spans more than one Spotify page");
  const items = await spotifyClient.listPlaylistTracks(user.id, longest.id);
  assert.equal(items.length, longest.trackCount);
  assert.ok(items.every((entry) => entry.item?.name && entry.item.artists?.[0]?.name));

  spotifyConnectionStore.clearConnection(user.id);
  await assert.rejects(spotifyClient.listPlaylists(user.id), (error) => error.statusCode === 401);
});

test("Ticketmaster shows near a ZIP code match library artists", async () => {
  configure({ ticketmaster: { ...dbOps.getSettings().integrations.ticketmaster, apiKey: labEnv.AURRAL_LAB_TICKETMASTER_API_KEY } });
  const [entry] = catalog.artists;
  const result = await getNearbyShows({ req: { headers: {}, ip: "127.0.0.1" }, zipCode: "97205", libraryArtists: [{ name: entry.name }] });
  assert.equal(result.location.resolved, true);
  assert.ok(result.libraryShows.some((show) => show.artistName === entry.name && show.date && show.venueName));
  const image = result.libraryShows[0].image;
  assert.deepEqual((await fetchImageBuffer(image)).subarray(0, 4), PNG);
});

test("Every built-in news feed returns articles with reachable artwork", async () => {
  let pageImages = 0;
  for (const feed of DEFAULT_NEWS_FEEDS) {
    const articles = await fetchRssFeed(feed);
    assert.ok(articles.length > 0, `${feed.url} returned no articles`);
    const withoutImage = articles.find((article) => !article.imageUrl);
    if (withoutImage && pageImages < 3) {
      const image = await fetchArticleImage(withoutImage.url);
      assert.deepEqual((await fetchImageBuffer(image)).subarray(0, 4), PNG);
      pageImages += 1;
    }
  }
  assert.ok(pageImages > 0);
});

test("Playlist artwork downloads a generated photo", async () => {
  assert.deepEqual((await fetchImageBuffer(await resolvePlaylistSourceImageUrl())).subarray(0, 4), PNG);
});

test("plex.tv sign-in issues tokens the Lab Plex server accepts, including home users", async () => {
  const clientId = "lab-public-test-client";
  const pin = await PlexClient.generatePin(clientId);
  assert.equal(await PlexClient.checkPin(pin.id, pin.code, clientId), null);
  const authUrl = new URL(PlexClient.buildAuthUrl(clientId, pin.code, null));
  const approved = await fetch(new URL("/lab/approve", authUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pin.code, clientId, accountId: 9001 }),
  });
  assert.equal(approved.status, 200);
  const accountToken = await PlexClient.checkPin(pin.id, pin.code, clientId);
  const identity = await PlexClient.validateToken(accountToken, clientId);
  assert.ok(identity.id);

  const { servers } = await PlexClient.getResources(accountToken, clientId);
  const server = servers.find((entry) => entry.clientIdentifier === labEnv.AURRAL_LAB_PLEX_MACHINE_IDENTIFIER);
  const plex = new PlexClient(server.connections[0].uri, server.accessToken, clientId);
  assert.equal(await plex.getMachineIdentifier(), labEnv.AURRAL_LAB_PLEX_MACHINE_IDENTIFIER);

  const users = await PlexClient.getHomeUsers(accountToken, clientId);
  const member = users.find((user) => !user.admin);
  const memberToken = await PlexClient.switchHomeUser(member.id, accountToken, clientId, clientId);
  const memberServer = (await PlexClient.getResources(memberToken, clientId)).servers[0];
  assert.notEqual(memberServer.accessToken, server.accessToken);
  assert.equal(await new PlexClient(memberServer.connections[0].uri, memberServer.accessToken, clientId).getMachineIdentifier(), labEnv.AURRAL_LAB_PLEX_MACHINE_IDENTIFIER);
  assert.equal(await PlexClient.validateToken("not-a-token", clientId), null);
});

test("Google sign-in links an account and signs it in through the Lab issuer", async () => {
  configure({
    google: {
      enabled: true,
      clientId: labEnv.AURRAL_LAB_GOOGLE_CLIENT_ID,
      clientSecret: labEnv.AURRAL_LAB_GOOGLE_CLIENT_SECRET,
      redirectUri: "http://127.0.0.1:3001/sso/google/callback",
    },
  });
  google.resetGoogleStateForTests();
  const user = createUser();
  const run = async (mode) => {
    const response = fakeResponse();
    await google.startGoogleAuth({ headers: {} }, response, { ...mode, returnUrl: true });
    const cookie = response.headers["Set-Cookie"].split(";", 1)[0];
    const callback = await approveSignIn(response.body.authUrl);
    const query = Object.fromEntries(callback.searchParams);
    const result = await google.handleGoogleCallback({ query, headers: { cookie }, ip: "127.0.0.1" });
    return google.exchangeGoogleCallback(result.code, { headers: { cookie }, ip: "127.0.0.1" });
  };
  assert.equal((await run({ mode: "link", linkUserId: user.id })).linked, true);
  const signedIn = await run({ mode: "login" });
  assert.equal(signedIn.user.id, user.id);
  assert.ok(signedIn.token);
});

test("Generic OIDC sign-in creates users with roles from the Lab issuer's groups", async () => {
  const env = { OIDC_ENABLED: "true", OIDC_ISSUER: labEnv.AURRAL_LAB_OIDC_ISSUER, OIDC_CLIENT_ID: labEnv.AURRAL_LAB_OIDC_CLIENT_ID, OIDC_CLIENT_SECRET: labEnv.AURRAL_LAB_OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI: "http://127.0.0.1:3001/sso/callback", OIDC_GROUPS_CLAIM: "groups", OIDC_ADMIN_GROUPS: "aurral-admins" };
  Object.assign(process.env, env);
  test.after(() => {
    for (const key of Object.keys(env)) delete process.env[key];
  });
  const signIn = async (accountIndex) => {
    oidc.resetOidcStateForTests();
    const response = fakeResponse();
    await oidc.startOidcLogin({ headers: {} }, response);
    const cookie = response.headers["Set-Cookie"].split(";", 1)[0];
    const callback = await approveSignIn(response.location, accountIndex);
    const result = await oidc.handleOidcCallback({ query: Object.fromEntries(callback.searchParams), headers: { cookie }, ip: "127.0.0.1" });
    return oidc.exchangeOidcCallback(result.code, { headers: { cookie }, ip: "127.0.0.1" });
  };
  const admin = await signIn(0);
  assert.equal(admin.user.role, "admin");
  const member = await signIn(1);
  assert.equal(member.user.role, "user");
  assert.notEqual(member.user.id, admin.user.id);
});

test("Gotify and webhook notifications reach the Lab receiver", async () => {
  await sendGotifyTest(labEnv.AURRAL_LAB_GOTIFY_URL, labEnv.AURRAL_LAB_GOTIFY_TOKEN);
  await assert.rejects(sendGotifyTest(labEnv.AURRAL_LAB_GOTIFY_URL, "wrong-token"), (error) => error.response?.status === 401);
  await sendWebhookTest({ url: labEnv.AURRAL_LAB_WEBHOOK_URL, body: '{"event":"$event"}', headers: [{ key: "X-Lab", value: "yes" }] });
  const state = await fixtureState("notify");
  assert.equal(state.messages.length, 1);
  assert.equal(state.hooks.length, 1);
  assert.deepEqual(state.hooks[0].body, { event: "webhookTest" });
  assert.equal(state.hooks[0].headers["x-lab"], "yes");
});
