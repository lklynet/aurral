import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps }, { flowPlaylistConfig }, { PlaylistManager }] =
  await setupIsolatedBackend(
    "navidrome-owner-name-prefix",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
    () => import("../../backend/services/playlists/playlistManager.ts"),
  );

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

function makeManager({ prefixOwnerUsername }: { prefixOwnerUsername?: boolean } = {}) {
  const manager = new PlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  if (prefixOwnerUsername !== undefined) {
    manager.navidromeDestination.updateConfig({ prefixOwnerUsername });
  }
  const created: string[] = [];
  const client = {
    created,
    isConfigured: () => true,
    async ensureAurralLibrary() {
      return null;
    },
    async getPlaylists(): Promise<{ id: string; name: string }[]> {
      return [];
    },
    async findSong() {
      return { id: "song-id" };
    },
    async createPlaylist(name: string) {
      created.push(name);
      return { id: name, name };
    },
    async updatePlaylist() {},
    async deletePlaylist(_id: string) {
      return { status: "ok" };
    },
    async scanLibrary() {
      return null;
    },
  };
  manager.navidromeDestination.client = client as unknown as NonNullable<
    typeof manager.navidromeDestination.client
  >;
  return Object.assign(manager, { testClient: client });
}

test("the Navidrome adapter keeps an unowned flow name bare", () => {
  const manager = makeManager({ prefixOwnerUsername: true });
  const names = manager.navidromeDestination.getPlaylistNames({
    entityId: "unowned-flow",
    displayName: "Weekend Vibes",
  });
  assert.equal(names.current, "Weekend Vibes");
  assert.deepEqual(names.legacy, ["[A] Weekend Vibes", "Aurral Weekend Vibes"]);
});

test("the Navidrome adapter prefixes an owned flow name when enabled", () => {
  const jody = userOps.createUser("jody", "hash", "user");
  assert.ok(jody != null);
  const manager = makeManager({ prefixOwnerUsername: true });
  const names = manager.navidromeDestination.getPlaylistNames({
    entityId: "owned-flow",
    ownerUserId: jody.id,
    displayName: "Weekend Vibes",
  });
  assert.equal(names.current, "jody - Weekend Vibes");
  assert.deepEqual(names.legacy, ["Weekend Vibes", "[A] Weekend Vibes", "Aurral Weekend Vibes"]);
});

test("the Navidrome adapter prefixes an owned static playlist name when enabled", () => {
  const jody = userOps.createUser("jody", "hash", "user");
  assert.ok(jody != null);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "80s Anthems" });
  const manager = makeManager({ prefixOwnerUsername: true });
  const names = manager.navidromeDestination.getPlaylistNames({
    entityId: playlist.id,
    ownerUserId: jody.id,
    displayName: "80s Anthems",
  });
  assert.equal(names.current, "jody - 80s Anthems");
  assert.deepEqual(names.legacy, ["80s Anthems", "[AS] 80s Anthems", "Aurral Shared 80s Anthems"]);
  flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
});

test("the Navidrome adapter keeps owned flow names bare when the toggle is off", () => {
  const jody = userOps.createUser("jody", "hash", "user");
  assert.ok(jody != null);
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "80s Anthems" });
  const manager = makeManager({ prefixOwnerUsername: false });

  const flow = manager.navidromeDestination.getPlaylistNames({
    entityId: "owned-flow",
    ownerUserId: jody.id,
    displayName: "Weekend Vibes",
  });
  assert.equal(flow.current, "Weekend Vibes");
  assert.deepEqual(flow.legacy, [
    "[A] Weekend Vibes",
    "Aurral Weekend Vibes",
    "jody - Weekend Vibes",
  ]);

  const shared = manager.navidromeDestination.getPlaylistNames({
    entityId: playlist.id,
    ownerUserId: jody.id,
    displayName: "80s Anthems",
  });
  assert.equal(shared.current, "80s Anthems");
  assert.deepEqual(shared.legacy, [
    "[AS] 80s Anthems",
    "Aurral Shared 80s Anthems",
    "jody - 80s Anthems",
  ]);
  flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
});

test("switching off the prefix deletes a leftover prefixed playlist with no pointer mapping", async () => {
  const jody = userOps.createUser("jody", "hash", "user");
  assert.ok(jody != null);
  const flow = flowPlaylistConfig.createFlow({ name: "Weekend Vibes", ownerUserId: jody.id });
  flowPlaylistConfig.setEnabled(flow.id, true);

  const manager = makeManager({ prefixOwnerUsername: false });

  // Existing native playlist from before the toggle flip; no pointer recorded for it.
  manager.testClient.getPlaylists = async () => [
    { id: "existing-1", name: "jody - Weekend Vibes" },
  ];
  const deleted: string[] = [];
  manager.testClient.deletePlaylist = async (id: string) => {
    deleted.push(id);
    return { status: "ok" };
  };

  await manager.syncPlaylists();

  assert.deepEqual(manager.testClient.created, ["Weekend Vibes"]);
  assert.deepEqual(deleted, ["existing-1"]);
  flowPlaylistConfig.deleteFlow(flow.id);
});

test("two different owners can use the same native playlist name", async () => {
  const gordon = userOps.createUser("gordon", "hash", "admin");
  assert.ok(gordon != null);
  const jody = userOps.createUser("jody", "hash", "user");
  assert.ok(jody != null);
  const gordonFlow = flowPlaylistConfig.createFlow({
    name: "Weekend Vibes",
    ownerUserId: gordon.id,
  });
  flowPlaylistConfig.setEnabled(gordonFlow.id, true);
  const jodyFlow = flowPlaylistConfig.createFlow({ name: "Weekend Vibes", ownerUserId: jody.id });
  flowPlaylistConfig.setEnabled(jodyFlow.id, true);

  const manager = makeManager({ prefixOwnerUsername: false });
  await manager.syncPlaylists();

  assert.deepEqual(manager.testClient.created.sort(), ["Weekend Vibes", "Weekend Vibes"].sort());
});
