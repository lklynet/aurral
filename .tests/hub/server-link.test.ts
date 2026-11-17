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

const approve = async (code: string) => {
  await hubAccount("account-1", "lee_k");
  assert.ok(await approveLink(hubEnv.DB, code.replace("-", ""), "account-1"));
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
  const track = { trackName: "Song", artistName: "Band" };
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
