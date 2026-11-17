import assert from "node:assert/strict";
import { afterAll, beforeEach, test, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import hub, { type Bindings } from "../../hub/src/index.ts";
import { approveLink, unlinkForAccount } from "../../hub/src/links.ts";
import { localHub } from "../../hub/testing.ts";

const HUB = "http://hub.test";
process.env.AURRAL_SHARE_ORIGIN = HUB;

const local = await localHub();
const hubEnv: Bindings = { ...local.env, HUB_ORIGIN: HUB, AUTH_SECRET: "x".repeat(40) };
const [
  paths,
  { db },
  { dbOps, userOps },
  link,
  { api },
  published,
  { flowPlaylistConfig },
  { syncStaticPlaylistImportHere },
  browse,
  friends,
  playEvents,
] = await setupIsolatedBackend(
  "server-link",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/hubLink.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/publicPlaylists.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/importLists/importListSync.ts"),
  () => import("../../backend/services/discovery/browsePlaylists.ts"),
  () => import("../../backend/services/hubFriends.ts"),
  () => import("../../backend/services/playEventService.ts"),
);
afterAll(async () => {
  await local.dispose();
  await cleanupIsolatedState(paths);
});

const admin = userOps.createUser("admin", "hash", "admin");
const lee = userOps.createUser("lee", "hash");
assert.ok(admin && lee);

let hubReachable = true;
let hubCalls = 0;
let revokes = 0;
let revokeWaiters: { count: number; resolve: () => void }[] = [];
const revoked = (count: number) =>
  new Promise<void>((resolve) => {
    if (revokes >= count) resolve();
    else revokeWaiters.push({ count, resolve });
  });

beforeEach(() => {
  hubReachable = true;
  hubCalls = 0;
  revokes = 0;
  revokeWaiters = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(HUB)) throw new Error(`unexpected fetch ${url}`);
    hubCalls += 1;
    if (!hubReachable) throw new TypeError("fetch failed");
    const response = await hub.request(url, { ...init, signal: undefined }, hubEnv);
    if (url.endsWith("/v1/links/revoke")) {
      revokes += 1;
      for (const waiter of revokeWaiters) if (revokes >= waiter.count) waiter.resolve();
    }
    return response;
  });
  db.prepare("DELETE FROM hub_links").run();
  db.prepare("DELETE FROM jobs").run();
  dbOps.updateSettings({ security: { localNetworkBypass: { enabled: false } } });
});

const hubAccount = async (id: string, handle: string) => {
  const now = new Date().toISOString();
  await hubEnv.DB.batch([
    hubEnv.DB.prepare(
      "INSERT OR IGNORE INTO accounts (id, name, email, email_verified, created_at, updated_at) VALUES (?, '', ?, 1, ?, ?)",
    ).bind(id, `${id}@users.aurral.org`, now, now),
    hubEnv.DB.prepare("INSERT OR IGNORE INTO handles (handle, account_id) VALUES (?, ?)").bind(
      handle,
      id,
    ),
  ]);
};

const approve = async (code: string, account = "account-1", handle = "lee_k") => {
  await hubAccount(account, handle);
  assert.ok(await approveLink(hubEnv.DB, code.replace("-", ""), account));
};

test("a user links through a code, and unlinking tells aurral.org to forget the link", async () => {
  const pending = await link.startHubLink(lee);
  assert.equal(pending.state, "pending");
  assert.ok(pending.state === "pending" && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pending.code));

  await approve(pending.state === "pending" ? pending.code : "");
  const linked = await link.hubLinkStatus(lee.id);
  assert.deepEqual(
    { state: linked.state, handle: "handle" in linked ? linked.handle : null },
    { state: "linked", handle: "lee_k" },
  );

  const token = db
    .prepare<[number], { token: string }>("SELECT token FROM hub_links WHERE user_id = ?")
    .get(lee.id)?.token;
  link.forgetHubLink(lee.id);
  assert.equal((await link.hubLinkStatus(lee.id)).state, "none");
  await revoked(1);
  const afterRevoke = await hub.request(
    `${HUB}/v1/link`,
    { headers: { authorization: `Bearer ${token}` } },
    hubEnv,
  );
  assert.equal(afterRevoke.status, 401);
});

test("a link removed on aurral.org shows as broken, and a dropped code goes back to not linked", async () => {
  const pending = await link.startHubLink(lee);
  await approve(pending.state === "pending" ? pending.code : "");
  await link.hubLinkStatus(lee.id);
  const linkId = await hubEnv.DB.prepare(
    "SELECT id FROM links WHERE account_id = 'account-1'",
  ).first<string>("id");
  await unlinkForAccount(hubEnv.DB, "account-1", linkId ?? "");
  assert.equal((await link.hubLinkStatus(lee.id)).state, "broken");

  const relink = await link.startHubLink(lee);
  assert.equal(relink.state, "pending");
  await revoked(1);
});

test("an unreachable aurral.org keeps what the server knows, and turning accounts off stops every call", async () => {
  const pending = await link.startHubLink(lee);
  await approve(pending.state === "pending" ? pending.code : "");
  await link.hubLinkStatus(lee.id);

  hubReachable = false;
  assert.equal((await link.hubLinkStatus(lee.id)).state, "linked");
  await assert.rejects(link.startHubLink(lee), link.HubLinkError);
  assert.equal((await link.hubLinkStatus(lee.id)).state, "linked");

  hubReachable = true;
  dbOps.updateSettings({
    security: { localNetworkBypass: { enabled: false }, aurralAccounts: false },
  });
  hubCalls = 0;
  const off = await link.hubLinkStatus(lee.id);
  assert.deepEqual(
    { state: off.state, available: off.available },
    { state: "linked", available: false },
  );
  await assert.rejects(link.startHubLink(lee), link.HubLinkError);
  assert.equal(hubCalls, 0);

  link.forgetHubLink(lee.id);
  await revoked(1);
});

test("deleting a user revokes its link", async () => {
  const doomed = userOps.createUser("doomed", "hash");
  assert.ok(doomed);
  await link.startHubLink(doomed);
  const response = await signedInAs(userOps.getUserById(admin.id) || undefined)
    .route("/", api)
    .request(`/users/${doomed.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  await revoked(1);
});

test("a public playlist reaches the shelf and its copies, stays fresh, and leaves with the link", async () => {
  const pending = await link.startHubLink(lee);
  await approve(pending.state === "pending" ? pending.code : "");
  await link.hubLinkStatus(lee.id);
  const owner = signedInAs(userOps.getUserById(lee.id) || undefined).route("/", api);
  const setPublic = (method: "PUT" | "DELETE", playlistId: string) =>
    owner.request(`/hub-link/public-playlists/${playlistId}`, { method });
  const track = {
    trackName: "Song",
    artistName: "Band",
    albumMbid: "1b105601-d2d3-4da2-a7d9-114f981b1766",
  };
  const mine = flowPlaylistConfig.createStaticPlaylist({
    name: "Late night",
    ownerUserId: lee.id,
    tracks: [track],
  });
  const synced = flowPlaylistConfig.createStaticPlaylist({
    name: "Rap Life",
    ownerUserId: lee.id,
    tracks: [track],
    importSource: {
      provider: "deezer-playlist",
      externalId: "1",
      syncEnabled: true,
      syncIntervalHours: 24,
    },
  });

  published.resetCommunityShelf();
  assert.deepEqual(await published.communityShelf(), []);
  assert.equal((await setPublic("PUT", mine.id)).status, 200);
  const [listed] = await published.communityShelf();
  assert.deepEqual(
    { title: listed?.title, handle: listed?.handle },
    { title: "Late night", handle: "lee_k" },
  );

  flowPlaylistConfig.updateStaticPlaylist(mine.id, { name: "Later night" });
  assert.equal((await published.refreshPublicPlaylists()).updated, 1);
  assert.equal((await published.refreshPublicPlaylists()).updated, 0);
  assert.equal((await published.communityPlaylist(listed?.id ?? "")).manifest.title, "Later night");
  const viewer = userOps.getUserById(admin.id) || undefined;
  assert.ok(viewer);
  const [card] = await browse.getCommunityPlaylists();
  const page = await browse.getBrowsePlaylist(viewer, "community", listed?.id ?? "");
  assert.equal(page.artworkUrl, card?.artworkUrl);
  assert.deepEqual(
    page.tracks.map(({ preview_url, artworkUrl }) => ({ preview_url, artworkUrl })),
    [
      {
        preview_url: "/api/deezer/preview?artist=Band&track=Song",
        artworkUrl: "/api/artists/release-group/1b105601-d2d3-4da2-a7d9-114f981b1766/cover/image",
      },
    ],
  );

  const copy = flowPlaylistConfig.createStaticPlaylist({
    name: "Later night",
    ownerUserId: admin.id,
    tracks: [track],
    importSource: {
      provider: "aurral-community",
      externalId: listed?.id,
      syncEnabled: true,
      syncIntervalHours: 24,
    },
  });
  const accounts = (aurralAccounts: boolean) =>
    dbOps.updateSettings({ security: { localNetworkBypass: { enabled: false }, aurralAccounts } });
  accounts(false);
  assert.equal((await setPublic("PUT", synced.id)).status, 409);
  assert.equal((await setPublic("DELETE", mine.id)).status, 200);
  accounts(true);
  assert.equal((await setPublic("PUT", synced.id)).status, 200);
  await syncStaticPlaylistImportHere({
    playlistId: copy.id,
    user: userOps.getUserById(admin.id) || undefined,
    force: true,
  });
  const ended = flowPlaylistConfig.getStaticPlaylist(copy.id);
  assert.equal(ended?.importSource?.syncEnabled, false);
  assert.equal(ended?.tracks.length, 1);

  assert.equal((await setPublic("PUT", mine.id)).status, 200);
  link.forgetHubLink(lee.id);
  assert.deepEqual(published.publicPlaylistState(lee.id).playlistIds, []);
  await revoked(1);
  published.resetCommunityShelf();
  assert.deepEqual(await published.communityShelf(), []);
});

test("linked users add each other as friends, and a failing aurral.org changes nothing", async () => {
  const mia = userOps.createUser("mia", "hash");
  assert.ok(mia);
  for (const [user, account, handle] of [
    [lee, "account-1", "lee_k"],
    [mia, "account-2", "mia_k"],
  ] as const) {
    const pending = await link.startHubLink(user);
    await approve(pending.state === "pending" ? pending.code : "", account, handle);
    await link.hubLinkStatus(user.id);
  }

  await assert.rejects(friends.addFriend(lee.id, "@nobody"), { status: 404 });
  hubCalls = 0;
  await assert.rejects(friends.addFriend(lee.id, "not a handle"), { status: 404 });
  assert.equal(hubCalls, 0);
  assert.deepEqual(await friends.addFriend(lee.id, "@Mia_K"), { status: "sent" });
  assert.deepEqual(await friends.friendLists(mia.id), {
    state: "linked",
    sharing: true,
    friends: [],
    incoming: [{ handle: "lee_k" }],
    outgoing: [],
  });
  assert.deepEqual(await friends.addFriend(mia.id, "lee_k"), { status: "friends" });
  await playEvents.sendNowPlaying(lee.id, {
    title: "Nude",
    artist: "Radiohead",
    album: "In Rainbows",
  });
  assert.deepEqual(await friends.friendLists(mia.id), {
    state: "linked",
    sharing: true,
    friends: [
      {
        handle: "lee_k",
        nowPlaying: {
          title: "Nude",
          artist: "Radiohead",
          album: "In Rainbows",
          artworkUrl: "/api/hub-link/friends/art?artist=Radiohead&album=In+Rainbows",
        },
        topPlays: null,
      },
    ],
    incoming: [],
    outgoing: [],
  });

  hubReachable = false;
  await assert.rejects(friends.friendLists(lee.id), { status: 502 });
  assert.equal((await link.hubLinkStatus(lee.id)).state, "linked");

  hubReachable = true;
  dbOps.updateSettings({
    security: { localNetworkBypass: { enabled: false }, aurralAccounts: false },
  });
  hubCalls = 0;
  assert.deepEqual(await friends.friendLists(lee.id), { state: "off" });
  await assert.rejects(friends.addFriend(lee.id, "mia_k"), { status: 409 });
  assert.equal(hubCalls, 0);
  await friends.removeFriend(lee.id, "mia_k");
  dbOps.updateSettings({
    security: { localNetworkBypass: { enabled: false }, aurralAccounts: true },
  });
  assert.deepEqual(await friends.friendLists(mia.id), {
    state: "linked",
    sharing: true,
    friends: [],
    incoming: [],
    outgoing: [],
  });

  const linkId = await hubEnv.DB.prepare(
    "SELECT id FROM links WHERE account_id = 'account-2' AND token_hash IS NOT NULL ORDER BY linked_at DESC",
  ).first<string>("id");
  await unlinkForAccount(hubEnv.DB, "account-2", linkId ?? "");
  assert.deepEqual(await friends.friendLists(mia.id), { state: "broken" });
  hubCalls = 0;
  assert.deepEqual(await friends.friendLists(mia.id), { state: "broken" });
  assert.equal(hubCalls, 0);
});

test("sharing sends now playing and top plays, Off clears aurral.org, and relinking keeps it off", async () => {
  await hubEnv.DB.prepare("DELETE FROM listening").run();
  const pending = await link.startHubLink(lee);
  await approve(pending.state === "pending" ? pending.code : "");
  await link.hubLinkStatus(lee.id);
  const listening = () =>
    hubEnv.DB.prepare("SELECT now_playing, top_plays FROM listening").first<{
      now_playing: string | null;
      top_plays: string | null;
    }>();
  const sharing = async () => {
    const status = await link.hubLinkStatus(lee.id);
    return status.state === "linked" && status.sharing;
  };
  for (const [index, title] of ["Reckoner", "Reckoner", "Nude"].entries()) {
    playEvents.recordPlayEvent(lee.id, {
      trackId: title,
      title,
      artist: "Radiohead",
      album: "In Rainbows",
      playedAt: Date.now() - (index + 1) * 600_000,
      source: "native-player",
    });
  }
  playEvents.recordPlayEvent(lee.id, {
    trackId: "old",
    title: "Creep",
    artist: "Radiohead",
    playedAt: Date.now() - 31 * 86_400_000,
  });

  await playEvents.sendNowPlaying(lee.id, { title: "Nude", artist: "Radiohead" });
  await friends.shareAllTopPlays();
  const shared = await listening();
  assert.deepEqual(JSON.parse(shared?.now_playing ?? ""), {
    title: "Nude",
    artist: "Radiohead",
    album: null,
  });
  assert.deepEqual(JSON.parse(shared?.top_plays ?? ""), {
    artists: [{ name: "Radiohead", plays: 3 }],
    albums: [{ title: "In Rainbows", artist: "Radiohead", plays: 3 }],
    tracks: [
      { title: "Reckoner", artist: "Radiohead", plays: 2 },
      { title: "Nude", artist: "Radiohead", plays: 1 },
    ],
  });

  hubReachable = false;
  await assert.rejects(friends.shareListening(lee.id, false), { status: 502 });
  hubReachable = true;
  assert.equal(await sharing(), true);

  await friends.shareListening(lee.id, false);
  assert.equal(await listening(), null);
  assert.equal(await sharing(), false);
  hubCalls = 0;
  await playEvents.sendNowPlaying(lee.id, { title: "Nude", artist: "Radiohead" });
  await friends.shareAllTopPlays();
  assert.equal(hubCalls, 0);

  const relink = await link.startHubLink(lee);
  await approve(relink.state === "pending" ? relink.code : "");
  assert.equal(await sharing(), false);
  await friends.shareListening(lee.id, true);
  assert.ok((await listening())?.top_plays);
  await revoked(1);
});
