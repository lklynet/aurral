import assert from "node:assert/strict";
import * as v from "valibot";
import { test, beforeEach, afterAll, afterEach, vi } from "vite-plus/test";
import { requireFixture } from "./fixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";

const [
  state,
  { db },
  { dbOps, userOps },
  { flowPlaylistConfig, invalidateFlowPlaylistConfigCache },
  { api },
  { getPlaylistStatusSnapshot },
  { playlistOperationQueue },
  { downloadTracker },
  { playlistManager },
  subsonic,
  { trackAdders },
  playlistOperations,
] = await setupIsolatedBackend(
  "playlist-members",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/services/playlists/playlistStatusSnapshot.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistManager.ts"),
  () => import("../../backend/services/subsonicLibraryService.ts"),
  () => import("../../backend/services/playlists/playlistMembers.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
);

const createUser = (username: string, role = "user", accessPlaylists = true): RequestUser => {
  const user = requireFixture(
    userOps.createUser(username, "hash", role, { accessPlaylists, accessSettings: false }),
  );
  return { id: user.id, username: user.username, role, permissions: user.permissions };
};

let lee: RequestUser;
let mia: RequestUser;
let kit: RequestUser;
let root: RequestUser;

const request = async (user: RequestUser, path: string, method = "GET", body?: unknown) => {
  const response = await signedInAs(user)
    .route("/", api)
    .request(path, {
      method,
      ...(body !== undefined && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  const json: unknown = await response.json();
  return { status: response.status, body: json };
};

const sharedPlaylist = (
  overrides: Parameters<typeof flowPlaylistConfig.createStaticPlaylist>[0],
) => {
  const playlist = flowPlaylistConfig.createStaticPlaylist({ ownerUserId: lee.id, ...overrides });
  return requireFixture(
    flowPlaylistConfig.updateStaticPlaylist(playlist.id, { memberUserIds: [mia.id] }),
  );
};

beforeEach(() => {
  resetDatabase(db);
  downloadTracker.clearAll();
  dbOps.updateSettings({ onboardingComplete: true, flows: [], staticPlaylists: [] });
  invalidateFlowPlaylistConfigCache();
  lee = createUser("lee");
  mia = createUser("mia");
  kit = createUser("kit");
  root = createUser("root", "admin");
  vi.spyOn(playlistOperationQueue, "enqueuePayload").mockResolvedValue({
    queued: true,
    operationId: 1,
  });
  vi.spyOn(playlistManager, "requestPlaylistSync").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  db.close();
  await cleanupIsolatedState(state);
});

test("members edit tracks and only the owner or an admin changes the playlist", async () => {
  const base = "/playlists/static-playlists";
  const cases = [
    ["owner", () => lee, [200, 200, 200, 200, 200, 200]],
    ["member", () => mia, [200, 200, 200, 403, 403, 403]],
    ["stranger", () => kit, [404, 404, 404, 404, 404, 404]],
    ["admin", () => root, [200, 200, 200, 200, 200, 200]],
  ] as const;
  for (const [actor, user, expected] of cases) {
    const { id } = sharedPlaylist({ name: `Shared by ${actor}` });
    const statuses = [
      (await request(user(), `/playlists/jobs/${id}`)).status,
      (await request(user(), `${base}/${id}/track-order`, "PUT", { jobIds: [] })).status,
      (
        await request(user(), `${base}/${id}/tracks`, "POST", {
          tracks: [{ artistName: "Artist", trackName: "Song" }],
        })
      ).status,
      (await request(user(), `${base}/${id}/record-history`, "PUT", { enabled: false })).status,
      (await request(user(), `${base}/${id}`, "PUT", { name: "Renamed" })).status,
      (await request(user(), `${base}/${id}/members`, "POST", { username: "kit" })).status,
    ];
    assert.deepEqual(statuses, expected, actor);
  }
  assert.ok(
    vi
      .mocked(playlistOperationQueue.enqueuePayload)
      .mock.calls.some(
        ([payload]) =>
          payload.kind === "static-playlist-append-tracks" && payload.actorUserId === mia.id,
      ),
  );
});

test("the owner sees who can be added and each refusal is explained", async () => {
  createUser("nova-off", "user", false);
  db.prepare(
    "INSERT INTO hub_links (user_id, origin, token, handle, linked_at) VALUES (?, 'https://hub.test', 't', 'kat', 1)",
  ).run(kit.id);
  const playlist = sharedPlaylist({ name: "Road trip" });
  const people = `/playlists/static-playlists/${playlist.id}/people`;
  assert.deepEqual((await request(lee, people)).body, {
    people: [
      { id: kit.id, username: "kit", handle: "kat" },
      { id: root.id, username: "root", handle: null },
    ],
  });
  assert.equal((await request(mia, people)).status, 403);
  const syncing = flowPlaylistConfig.createStaticPlaylist({
    name: "Synced",
    ownerUserId: lee.id,
    importSource: {
      provider: "spotify-playlist",
      externalId: "abc",
      syncEnabled: true,
      syncIntervalHours: 24,
    },
  });
  const cases = [
    [playlist.id, "nova", 404, "No one on this server is called nova."],
    [playlist.id, "MIA", 409, "mia is already on this playlist."],
    [playlist.id, "lee", 409, "lee owns this playlist."],
    [playlist.id, "nova-off", 409, "nova-off can't use playlists on this server."],
    [syncing.id, "kit", 409, "This playlist syncs from Spotify, so it can't have collaborators."],
  ] as const;
  const syncingPeople = await request(lee, `/playlists/static-playlists/${syncing.id}/people`);
  assert.deepEqual(
    [syncingPeople.status, syncingPeople.body],
    [409, { error: "This playlist syncs from Spotify, so it can't have collaborators." }],
  );
  for (const [id, username, status, error] of cases) {
    const response = await request(lee, `/playlists/static-playlists/${id}/members`, "POST", {
      username,
    });
    assert.deepEqual([response.status, response.body], [status, { error }], username);
  }
  const added = await request(lee, `/playlists/static-playlists/${playlist.id}/members`, "POST", {
    username: " Kit ",
  });
  assert.deepEqual(added.body, {
    members: [
      { id: mia.id, username: "mia", handle: null },
      { id: kit.id, username: "kit", handle: "kat" },
    ],
  });
});

test("a playlist with collaborators can't sync or be replaced wholesale", async () => {
  const playlist = sharedPlaylist({
    name: "Imported",
    importSource: { provider: "spotify-playlist", externalId: "abc", syncEnabled: false },
  });
  const path = `/playlists/static-playlists/${playlist.id}`;
  const replaced = await request(lee, path, "PUT", { tracks: [] });
  const synced = await request(lee, path, "PUT", {
    importSource: { syncEnabled: true, syncIntervalHours: 24 },
  });
  const syncedNow = await request(lee, `${path}/sync`, "POST");
  assert.deepEqual([replaced.status, synced.status, syncedNow.status], [409, 409, 409]);
  await assert.rejects(
    playlistOperations.updateStaticPlaylist({
      playlistId: playlist.id,
      hasImportSourceUpdate: true,
      importSource: { ...playlist.importSource, syncEnabled: true },
    }),
    /collaborators/,
  );
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).importSource?.syncEnabled,
    false,
  );
});

test("a member who leaves loses the playlist at once and can't remove others", async () => {
  const playlist = sharedPlaylist({ name: "Leaving" });
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, { memberUserIds: [mia.id, kit.id] });
  const members = `/playlists/static-playlists/${playlist.id}/members`;
  const snapshot = getPlaylistStatusSnapshot({ user: mia });
  assert.deepEqual(requireFixture(snapshot.staticPlaylists[0]).members, [
    { id: mia.id, username: "mia", handle: null },
    { id: kit.id, username: "kit", handle: null },
  ]);

  assert.equal((await request(mia, `${members}/${kit.id}`, "DELETE")).status, 403);
  const left = await request(mia, `${members}/${mia.id}`, "DELETE");
  assert.deepEqual(left.body, { members: [{ id: kit.id, username: "kit", handle: null }] });
  assert.equal((await request(mia, `/playlists/jobs/${playlist.id}`)).status, 404);
  assert.equal(getPlaylistStatusSnapshot({ user: mia }).staticPlaylists.length, 0);
  assert.equal(subsonic.getSubsonicPlaylist(`shared:${playlist.id}`, mia), null);

  await request(lee, `${members}/${kit.id}`, "DELETE");
  assert.equal(
    requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).memberUserIds,
    undefined,
  );
});

test("tracks remember who added them, and copies start fresh", async () => {
  const playlist = sharedPlaylist({ name: "Mixed" });
  const add = (trackName: string, actor: number) => {
    const canonicalJobId = requireFixture(
      downloadTracker.addJob({ artistName: "Artist", trackName }, "library", {
        startedByPlaylist: playlist.id,
      }),
    );
    flowPlaylistConfig.appendStaticPlaylistTracks(
      playlist.id,
      [{ artistName: "Artist", trackName, canonicalJobId, addedByUserId: kit.id }],
      actor,
    );
  };
  add("Owner pick", lee.id);
  add("Member pick", mia.id);
  const stored = requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id));
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
    tracks: [...stored.tracks].reverse(),
    actorUserId: lee.id,
  });

  const jobs = await request(mia, `/playlists/jobs/${playlist.id}`);
  assert.deepEqual(
    v
      .parse(
        v.array(v.looseObject({ trackName: v.string(), addedBy: v.nullable(v.string()) })),
        jobs.body,
      )
      .map((job) => [job.trackName, job.addedBy]),
    [
      ["Member pick", "mia"],
      ["Owner pick", "lee"],
    ],
  );
  const copy = flowPlaylistConfig.createStaticPlaylist({
    name: "Copy",
    ownerUserId: kit.id,
    tracks: requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id)).tracks,
  });
  assert.deepEqual(
    copy.tracks.map((track) => track.addedByUserId),
    [undefined, undefined],
  );
});

test("deleting the owner hands the playlist to its first member", async () => {
  const playlist = sharedPlaylist({
    name: "Inherited",
    tracks: [{ artistName: "Artist", trackName: "Old owner pick", canonicalJobId: "job-1" }],
  });
  flowPlaylistConfig.updateStaticPlaylist(playlist.id, { memberUserIds: [mia.id, kit.id] });
  assert.equal((await request(root, `/users/${lee.id}`, "DELETE")).status, 200);
  const inherited = requireFixture(flowPlaylistConfig.getStaticPlaylist(playlist.id));
  assert.deepEqual([inherited.ownerUserId, inherited.memberUserIds], [mia.id, [kit.id]]);
  assert.deepEqual(trackAdders(inherited), new Map([["job-1", null]]));
});

test("Subsonic lists collaborators and keeps the owner's edits to the owner", async () => {
  const playlist = sharedPlaylist({ name: "Shared on Subsonic" });
  const listed = subsonic.getSubsonicPlaylists(mia).find((entry) => entry.name === playlist.name);
  assert.deepEqual([listed?.owner, listed?.allowedUser], ["lee", ["mia"]]);
  for (const edit of [
    () =>
      subsonic.updateSubsonicPlaylist(mia, { playlistId: `shared:${playlist.id}`, name: "Mine" }),
    () =>
      subsonic.updateSubsonicPlaylist(mia, { playlistId: `shared:${playlist.id}`, songIds: [] }),
    () => subsonic.deleteSubsonicPlaylist(mia, `shared:${playlist.id}`),
  ]) {
    await assert.rejects(edit, { code: "SUBSONIC_PLAYLIST_READ_ONLY" });
  }
  assert.ok(
    await subsonic.updateSubsonicPlaylist(mia, {
      playlistId: `shared:${playlist.id}`,
      name: playlist.name,
    }),
  );
});
