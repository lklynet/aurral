import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { beforeEach, test, vi } from "vite-plus/test";
import { resetDatabase, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { testUser } from "../helpers/userFixtures.ts";

const [
  ,
  { db },
  store,
  { getUserMixes, getUserMix, clearUserMixes },
  browse,
  covers,
  operations,
  { requireImportList },
] = await setupIsolatedBackend(
  "discovery-mixes",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/discovery/mixes.ts"),
  () => import("../../backend/services/discovery/browsePlaylists.ts"),
  () => import("../../backend/services/discovery/browseCovers.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
  () => import("../../backend/services/importLists/importPlaylist.ts"),
);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12);

function addArtist(name: string, trackCount: number, genres: string[] = []) {
  const artist = store.upsertLibraryArtist({
    identityKey: `artist:${name}`,
    name,
    metadata: genres.length ? { genres } : null,
  });
  const album = store.upsertLibraryAlbum({
    identityKey: `album:${name}`,
    artistId: artist.id,
    title: `${name} LP`,
  });
  const tracks = Array.from({ length: trackCount }, (_, index) => {
    const track = store.upsertLibraryTrack({
      identityKey: `track:${name}:${index}`,
      title: `${name} ${index}`,
      artistName: name,
    });
    store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
    store.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: `/music/${name}/${index}.flac`,
      format: "flac",
    });
    return track;
  });
  return { artist, tracks };
}

const insertPlay = db.prepare<[number, string, string, string, number]>(`
  INSERT INTO play_events (user_id, track_id, title, artist, played_at, source, created_at)
  VALUES (?, ?, ?, ?, ?, 'test', 0)
`);

function play(trackId: string, title: string, artist: string, times: number, daysAgo: number) {
  for (let index = 0; index < times; index += 1) {
    insertPlay.run(userId, trackId, title, artist, NOW - daysAgo * DAY - index * 1000);
  }
}

const artistOf = (trackId: number) =>
  db
    .prepare<[number], { name: string }>(
      "SELECT artist_name AS name FROM library_tracks WHERE id = ?",
    )
    .get(trackId)!.name;

let userId = 0;

beforeEach(() => {
  resetDatabase(db);
  clearUserMixes();
  userId = db
    .prepare<[], { id: number }>(
      "INSERT INTO users (username, password_hash) VALUES ('listener', 'x') RETURNING id",
    )
    .get()!.id;
});

test("listening mixes rank Library tracks by when and how often they were played", async () => {
  const boards = addArtist("Boards", 12);
  const caribou = addArtist("Caribou", 12);
  const daft = addArtist("Daft", 12);
  boards.tracks.forEach((track, index) => {
    const id =
      index % 3 === 0
        ? String(track.id)
        : index % 3 === 1
          ? `song:${encodeURIComponent(`track:Boards:${index}`)}`
          : `plex:${index}`;
    play(id, track.title, "Boards", 14 - index, 3);
  });
  caribou.tracks.forEach((track, index) =>
    play(index === 0 ? "999999" : String(track.id), track.title, "Caribou", 3, 120),
  );
  daft.tracks.forEach((track) => play(String(track.id), track.title, "Daft", 4, 400));
  play("history:gone", "Not In Library", "Boards", 20, 2);

  const mixes = await getUserMixes(userId, NOW);
  const byId = new Map(mixes.map((mix) => [mix.id, mix]));

  assert.deepEqual(
    byId.get("on-repeat")?.trackIds,
    boards.tracks.map((track) => track.id).slice(0, 12),
  );
  assert.ok(byId.get("rewind")?.trackIds.every((id) => artistOf(id) === "Caribou"));
  assert.equal(byId.get("rewind")?.trackIds.length, 12);
  assert.ok(byId.get("rediscover")?.trackIds.every((id) => artistOf(id) === "Daft"));
  assert.deepEqual(
    mixes.filter((mix) => mix.id.startsWith("radio-")).map((mix) => mix.name),
    ["Boards Radio"],
  );

  const radio = mixes.find((mix) => mix.id.startsWith("radio-"))!;
  const cover = await browse.getBrowseCover(testUser(userId), "mix", radio.id);
  assert.deepEqual(cover, {
    title: "Boards Radio",
    template: "d1",
    artist: { artistName: "Boards", artistMbid: null },
  });
  const [drawn, reused] = await Promise.all([
    covers.browseCoverFile(cover),
    covers.browseCoverFile(cover),
  ]);
  assert.equal(drawn, reused);
  assert.ok((await fs.stat(drawn)).size > 0);

  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const enqueue = vi.spyOn(operations.playlistOperationQueue, "enqueuePayload");
  await browse.saveBrowsePlaylist(testUser(userId), "mix", "on-repeat");
  assert.partialDeepStrictEqual(enqueue.mock.calls[0]?.[0], {
    importSource: {
      provider: "aurral-mix",
      externalId: "on-repeat",
      syncEnabled: true,
      keepRemovedTracks: true,
    },
  });
  const saved = enqueue.mock.calls[0]?.[0]?.tracks;
  assert.ok(Array.isArray(saved));
  assert.deepEqual(
    saved
      .slice(0, 2)
      .map((track) => (track && typeof track === "object" && "path" in track ? track.path : null)),
    ["/music/Boards/0.flac", "/music/Boards/1.flac"],
  );

  caribou.tracks.forEach((track) => play(String(track.id), track.title, "Caribou", 30, 1));
  clearUserMixes();
  const synced = await requireImportList("aurral-mix").fetch({ userId, externalId: "on-repeat" });
  assert.equal(synced.tracks[0]?.artistName, "Caribou");
});

test("Daily Mixes group the most played artists by shared genre", async () => {
  for (const [name, genre, plays] of [
    ["Avalon", "house", 9],
    ["Bicep", "house", 8],
    ["Coltrane", "jazz", 7],
    ["Davis", "jazz", 6],
  ] as const) {
    const { tracks } = addArtist(name, 12, [genre]);
    for (const track of tracks) play(String(track.id), track.title, name, plays, 5);
  }

  const daily = (await getUserMixes(userId, NOW)).filter((mix) => mix.id.startsWith("daily-"));

  assert.deepEqual(
    daily.map((mix) => [mix.name, mix.description]),
    [
      ["Daily Mix 1", "Avalon and Bicep"],
      ["Daily Mix 2", "Coltrane and Davis"],
    ],
  );
  const built = await getUserMixes(userId, NOW);
  const later = NOW + 31 * 60_000;
  assert.equal(await getUserMixes(userId, later), built);
  insertPlay.run(userId, "history:old", "Old Song", "Avalon", NOW - 90 * DAY);
  assert.notEqual(await getUserMixes(userId, later + 31 * 60_000), built);
});

test("Blends mix two people's plays with their 3 closest listeners until either turns it off", async () => {
  const { setBlendSetting, getBlendSetting } =
    await import("../../backend/services/discovery/mixes.ts");
  const { addDiscoveryFeedback } = await import("../../backend/services/discovery/feedback.ts");
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const person = (username: string) =>
    db
      .prepare<[string], { id: number }>(
        "INSERT INTO users (username, password_hash) VALUES (?, 'x') RETURNING id",
      )
      .get(username)!.id;
  const [lee, mia, kit, nova, sam, zed] = ["lee", "mia", "kit", "nova", "sam", "zed"].map(
    person,
  ) as [number, number, number, number, number, number];
  const plays = (listeners: number[], names: string[]) => {
    for (const name of names) {
      for (const track of addArtist(name, 3).tracks) {
        for (const listener of listeners) {
          insertPlay.run(listener, `history:${track.title}`, track.title, name, NOW - DAY);
        }
      }
    }
  };
  plays([lee, mia, nova, sam], ["Shared A"]);
  plays([lee, mia], ["Shared B"]);
  plays([lee], ["Lee A", "Lee B", "Lee C"]);
  plays([mia], ["Mia A", "Mia B", "Mia C", "Blocked"]);
  plays([nova], ["Nova"]);
  plays([sam], ["Sam"]);
  plays([kit], ["Kit", "Kit B"]);
  for (const track of addArtist("Mia Old", 3).tracks) {
    insertPlay.run(mia, `history:${track.title}`, track.title, "Mia Old", NOW - 40 * DAY);
  }
  insertPlay.run(zed, "history:Kit 0", "Kit 0", "Kit", NOW - DAY);
  for (let index = 0; index < 250; index += 1) {
    for (let time = 0; time < 3; time += 1) {
      insertPlay.run(mia, `history:ghost-${index}`, `Ghost ${index}`, "Ghost", NOW - DAY - time);
    }
  }
  addDiscoveryFeedback(lee, { action: "block_artist", artistName: "Blocked" });

  const blendOf = async (viewer: number, partner: number) =>
    (await getUserMixes(viewer, NOW)).find((mix) => mix.id === `blend-${partner}`);
  const blendNames = async (viewer: number) =>
    (await getUserMixes(viewer, NOW))
      .filter((mix) => mix.id.startsWith("blend-"))
      .map((mix) => mix.name);
  assert.deepEqual(await blendNames(lee), ["Blend with mia", "Blend with nova", "Blend with sam"]);
  assert.equal((await getUserMix(lee, `blend-${kit}`, NOW))?.name, "Blend with kit");
  assert.deepEqual(await getBlendSetting(kit), { enabled: true, waiting: ["zed"] });
  const forLee = await blendOf(lee, mia);
  const forMia = await blendOf(mia, lee);
  assert.deepEqual(forMia?.trackIds, forLee?.trackIds);
  const reasons = (blend: typeof forLee) =>
    new Set(
      blend?.trackIds.map((id) => `${artistOf(id).split(" ")[0]}: ${blend.reasons?.get(id)}`),
    );
  assert.deepEqual([...reasons(forLee)].sort(), [
    "Lee: From you",
    "Mia: From mia",
    "Shared: You both play this",
  ]);
  assert.deepEqual([...reasons(forMia)].sort(), [
    "Lee: From lee",
    "Mia: From you",
    "Shared: You both play this",
  ]);
  const saved = await requireImportList("aurral-mix").fetch({
    userId: lee,
    externalId: `blend-${mia}`,
  });
  assert.deepEqual(saved.tracks.length > 0 && saved.tracks.filter((track) => track.reason), []);
  const miasTracks = await getUserMix(lee, `listens-${mia}`, NOW);
  assert.equal(miasTracks?.name, "mia's tracks");
  assert.deepEqual(
    new Set(miasTracks?.trackIds.map(artistOf)),
    new Set(["Shared A", "Shared B", "Mia A", "Mia B", "Mia C"]),
  );
  assert.equal(await getUserMix(lee, `listens-${kit}`, NOW), null);
  addDiscoveryFeedback(mia, { action: "block_artist", artistName: "Lee A" });
  assert.ok((await blendOf(lee, mia))?.trackIds.every((id) => artistOf(id) !== "Lee A"));

  await setBlendSetting(mia, false);
  assert.equal(await getUserMix(lee, `blend-${mia}`, NOW), null);
  assert.equal(await getUserMix(lee, `listens-${mia}`, NOW), null);
  await setBlendSetting(mia, true);
  await setBlendSetting(lee, false);
  assert.equal(await getUserMix(mia, `blend-${lee}`, NOW), null);
  await setBlendSetting(lee, true);
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(mia);
  assert.equal(await blendOf(lee, mia), undefined);
});

test("a friend Blend mixes your plays with a friend's tracks, or their artists' when the track is missing", async () => {
  const { addDiscoveryFeedback } = await import("../../backend/services/discovery/feedback.ts");
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  db.prepare(
    "INSERT INTO hub_links (user_id, origin, token, handle, linked_at) VALUES (?, 'https://aurral.org', 't', 'lee_k', 1)",
  ).run(userId);
  const friendTracks = (handle: string, names: [string, string][]) =>
    db
      .prepare(
        "INSERT INTO hub_friend_tracks (user_id, handle, tracks, fetched_at) VALUES (?, ?, ?, 1)",
      )
      .run(userId, handle, JSON.stringify(names.map(([artist, title]) => ({ title, artist }))));
  const tracksOf = (name: string, count: number) =>
    addArtist(name, count).tracks.map((track): [string, string] => [name, track.title]);
  const shared = tracksOf("Shared", 3);
  for (const [artist, title] of [...shared, ...tracksOf("Mine A", 3), ...tracksOf("Mine B", 3)]) {
    play(`history:${title}`, title, artist, 2, 1);
  }
  friendTracks("nova_k", [
    ...shared,
    ...tracksOf("Élan", 3).slice(2),
    ["Élan", "Not in this Library"],
    ...tracksOf("Blocked", 3),
    ["Elsewhere", "Not in this Library"],
  ]);
  addDiscoveryFeedback(userId, { action: "block_artist", artistName: "Blocked" });
  const mia = db
    .prepare<[], { id: number }>(
      "INSERT INTO users (username, password_hash) VALUES ('mia', 'x') RETURNING id",
    )
    .get()!.id;
  db.prepare(
    "INSERT INTO hub_links (user_id, origin, token, handle, linked_at) VALUES (?, 'https://aurral.org', 'm', 'mia_k', 1)",
  ).run(mia);
  const mias = [...shared, ...tracksOf("Mia", 3)];
  for (const [artist, title] of mias)
    insertPlay.run(mia, `history:${title}`, title, artist, NOW - DAY);
  friendTracks("mia_k", mias);

  const blend = await getUserMix(userId, "friend-blend-nova_k", NOW);
  assert.equal(blend?.name, "Blend with @nova_k");
  assert.deepEqual(
    [
      ...new Set(
        blend?.trackIds.map((id) => `${artistOf(id).split(" ")[0]}: ${blend.reasons?.get(id)}`),
      ),
    ].sort(),
    ["Mine: From you", "Shared: You both play this", "Élan: From @nova_k"],
  );
  assert.deepEqual(blend?.trackIds.map(artistOf).filter((name) => name === "Élan").length, 2);
  assert.ok(
    blend?.trackIds.includes(
      db.prepare<[], { id: number }>("SELECT id FROM library_tracks WHERE title = 'Élan 2'").get()!
        .id,
    ),
  );
  assert.deepEqual(
    (await getUserMixes(userId, NOW))
      .filter((mix) => mix.id.includes("blend"))
      .map((mix) => mix.id),
    [`blend-${mia}`, "friend-blend-nova_k"],
  );

  db.prepare("UPDATE hub_links SET share_listening = 0").run();
  assert.equal(await getUserMix(userId, "friend-blend-nova_k", NOW), null);
});
