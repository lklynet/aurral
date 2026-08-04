import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, , { plexPlaylistPointerStore }] = await setupIsolatedBackend(
  "plex-playlist-pointer-store",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/plex/plexPlaylistPointerStore.js",
);

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("getPointer returns null when nothing is tracked", () => {
  assert.equal(plexPlaylistPointerStore.getPointer("flow-1", "global"), null);
});

test("setPointer/getPointer round-trip, including description", () => {
  plexPlaylistPointerStore.setPointer("flow-1", "global", {
    location: "global",
    ratingKey: 501,
    title: "Discover Weekly",
    description: "Fresh picks from your recommendation profile",
  });
  const pointer = plexPlaylistPointerStore.getPointer("flow-1", "global");
  assert.equal(pointer.location, "global");
  assert.equal(pointer.ratingKey, "501", "ratingKey is normalized to a string");
  assert.equal(pointer.title, "Discover Weekly");
  assert.equal(pointer.description, "Fresh picks from your recommendation profile");
  assert.equal(typeof pointer.updatedAt, "number");
});

test("setPointer defaults description to null when omitted", () => {
  plexPlaylistPointerStore.setPointer("flow-2", "global", {
    location: "global",
    ratingKey: 502,
    title: "Trending Mix",
  });
  assert.equal(plexPlaylistPointerStore.getPointer("flow-2", "global").description, null);
});

test("setPointer overwrites an existing pointer for the same entity+target", () => {
  plexPlaylistPointerStore.setPointer("flow-3", "5", {
    location: "managed:100",
    ratingKey: 1,
    title: "Old",
  });
  plexPlaylistPointerStore.setPointer("flow-3", "5", {
    location: "managed:100",
    ratingKey: 2,
    title: "New",
  });
  const pointer = plexPlaylistPointerStore.getPointer("flow-3", "5");
  assert.equal(pointer.ratingKey, "2");
  assert.equal(pointer.title, "New");
});

test("different target keys for the same entity are tracked independently", () => {
  plexPlaylistPointerStore.setPointer("flow-4", "global", {
    location: "global",
    ratingKey: 10,
    title: "Metal Mayhem",
  });
  plexPlaylistPointerStore.setPointer("flow-4", "5", {
    location: "managed:100",
    ratingKey: 11,
    title: "Metal Mayhem",
  });
  assert.equal(plexPlaylistPointerStore.getPointer("flow-4", "global").ratingKey, "10");
  assert.equal(plexPlaylistPointerStore.getPointer("flow-4", "5").ratingKey, "11");
});

test("deletePointer removes the entry and reports whether one existed", () => {
  plexPlaylistPointerStore.setPointer("flow-5", "global", {
    location: "global",
    ratingKey: 20,
    title: "X",
  });
  assert.equal(plexPlaylistPointerStore.deletePointer("flow-5", "global"), true);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-5", "global"), null);
  assert.equal(plexPlaylistPointerStore.deletePointer("flow-5", "global"), false);
});

test("deletePointer only removes the given target, leaving sibling targets for the same entity intact", () => {
  plexPlaylistPointerStore.setPointer("flow-6", "global", {
    location: "global",
    ratingKey: 30,
    title: "X",
  });
  plexPlaylistPointerStore.setPointer("flow-6", "5", {
    location: "managed:100",
    ratingKey: 31,
    title: "X",
  });
  plexPlaylistPointerStore.deletePointer("flow-6", "global");
  assert.equal(plexPlaylistPointerStore.getPointer("flow-6", "global"), null);
  assert.equal(plexPlaylistPointerStore.getPointer("flow-6", "5").ratingKey, "31");
});

test("getPointersForTarget finds every entity tracked under one sync target, across different entities", () => {
  plexPlaylistPointerStore.setPointer("flow-a", "5", {
    location: "managed:100",
    ratingKey: 40,
    title: "Discover Weekly",
  });
  plexPlaylistPointerStore.setPointer("flow-b", "5", {
    location: "managed:100",
    ratingKey: 41,
    title: "Listening History",
  });
  plexPlaylistPointerStore.setPointer("flow-c", "6", {
    location: "managed:200",
    ratingKey: 42,
    title: "Discover Weekly",
  });
  const results = plexPlaylistPointerStore.getPointersForTarget("5");
  assert.equal(results.length, 2);
  const entityIds = results.map((r) => r.entityId).sort();
  assert.deepEqual(entityIds, ["flow-a", "flow-b"]);
  assert.ok(results.every((r) => r.location === "managed:100"));
});

test("getPointersForTarget returns an empty array when nothing is tracked for that target", () => {
  assert.deepEqual(plexPlaylistPointerStore.getPointersForTarget("999"), []);
});

test("getPointersForEntity finds every sync target for one entity, e.g. every broadcast target of an editorial playlist", () => {
  plexPlaylistPointerStore.setPointer("editorial-1", "global", {
    location: "global",
    ratingKey: 50,
    title: "Metal Mayhem",
  });
  plexPlaylistPointerStore.setPointer("editorial-1", "5", {
    location: "managed:100",
    ratingKey: 51,
    title: "Metal Mayhem",
  });
  plexPlaylistPointerStore.setPointer("editorial-1", "6", {
    location: "self:200",
    ratingKey: 52,
    title: "Metal Mayhem",
  });
  const results = plexPlaylistPointerStore.getPointersForEntity("editorial-1");
  assert.equal(results.length, 3);
  const targetKeys = results.map((r) => r.targetKey).sort();
  assert.deepEqual(targetKeys, ["5", "6", "global"]);
});

test("getPointersForEntity returns an empty array for an entity with no pointers", () => {
  assert.deepEqual(plexPlaylistPointerStore.getPointersForEntity("nothing-here"), []);
});

test("getPointersForEntity does not include pointers belonging to a different entity", () => {
  plexPlaylistPointerStore.setPointer("flow-x", "global", {
    location: "global",
    ratingKey: 60,
    title: "X",
  });
  plexPlaylistPointerStore.setPointer("flow-y", "global", {
    location: "global",
    ratingKey: 61,
    title: "Y",
  });
  const results = plexPlaylistPointerStore.getPointersForEntity("flow-x");
  assert.equal(results.length, 1);
  assert.equal(results[0].ratingKey, "60");
});
