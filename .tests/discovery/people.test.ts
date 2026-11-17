import assert from "node:assert/strict";
import { testClient } from "hono/testing";
import { test, vi } from "vite-plus/test";
import { setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";

const [, { db }, { userOps }, { default: peopleRoutes }, playEvents, { setBlendSetting }] =
  await setupIsolatedBackend(
    "local-people",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/routes/people.ts"),
    () => import("../../backend/services/playEventService.ts"),
    () => import("../../backend/services/discovery/mixes.ts"),
  );

const NOW = Date.UTC(2026, 10, 5, 12);

test("people on this server see each other's listening only while both share", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const person = (name: string) => {
    const user = userOps.createUser(name, "hash");
    assert.ok(user);
    return user;
  };
  const lee = person("lee");
  const mia = person("mia");
  const kit = person("kit");
  const play = db.prepare<[number, string, number]>(
    "INSERT INTO play_events (user_id, track_id, title, artist, played_at, source, created_at) VALUES (?, 'x', ?, 'Radiohead', ?, 'test', 0)",
  );
  for (const user of [lee, mia]) play.run(user.id, "Nude", NOW - 60_000);
  play.run(mia.id, "Airbag", NOW - 120_000);
  const as = (user: typeof lee) =>
    testClient(signedInAs(userOps.getUserById(user.id) || undefined).route("/", peopleRoutes))
      .people;
  const profile = async (user: typeof lee, username: string) =>
    (await as(user)[":username"].$get({ param: { username } })).status;
  const people = async (user: typeof lee) => {
    const body = await (await as(user).$get()).json();
    return {
      sharing: body.sharing,
      people: body.people.map((each) => [
        each.username,
        each.nowPlaying?.title ?? null,
        `${each.lastPlayed.title} ${each.lastPlayed.at}`,
      ]),
    };
  };

  await playEvents.sendNowPlaying(mia.id, {
    title: "Reckoner",
    artist: "Radiohead",
    durationMs: 60_000,
  });
  const nude = `Nude ${NOW - 60_000}`;
  assert.deepEqual(await people(lee), { sharing: true, people: [["mia", "Reckoner", nude]] });
  assert.equal(await profile(lee, "MIA"), 200);
  assert.equal(await profile(lee, "kit"), 404);
  const link = db.prepare<[number, string, string]>(
    "INSERT OR REPLACE INTO hub_links (user_id, origin, token, handle, linked_at) VALUES (?, ?, 't', ?, 1)",
  );
  const miasHandle = async () => (await (await as(lee).$get()).json()).people[0]?.handle;
  link.run(lee.id, "https://aurral.org", "lee_k");
  link.run(mia.id, "https://other.hub", "mia_k");
  assert.equal(await miasHandle(), null);
  link.run(mia.id, "https://aurral.org", "mia_k");
  assert.equal(await miasHandle(), "mia_k");
  vi.spyOn(Date, "now").mockReturnValue(NOW + 60_000);
  assert.deepEqual(await people(lee), { sharing: true, people: [["mia", null, nude]] });

  await setBlendSetting(lee.id, false);
  assert.deepEqual(await people(lee), { sharing: false, people: [] });
  assert.equal(await profile(mia, "lee"), 404);
  assert.equal(await profile(lee, "Lee"), 200);
  assert.deepEqual(await people(kit), { sharing: true, people: [["mia", null, nude]] });
});
