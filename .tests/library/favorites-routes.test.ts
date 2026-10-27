import assert from "node:assert/strict";
import { test, beforeAll, afterAll } from "vite-plus/test";
import type { hc, InferResponseType } from "hono/client";
import type libraryIndex from "../../backend/routes/library/handlers/libraryIndex.ts";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import { signedInAs } from "../helpers/honoApp.ts";
type LibraryRoutes = ReturnType<typeof hc<typeof libraryIndex>>["library"];
type LibraryPage = InferResponseType<LibraryRoutes["canonical"]["$get"], 200>;
type Page<Kind extends LibraryPage["kind"]> = Extract<LibraryPage, { kind: Kind }>;
type Favorites = InferResponseType<LibraryRoutes["favorites"]["$get"], 200>;
type FavoritesUpdate = InferResponseType<LibraryRoutes["favorites"]["$post"], 200>;

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { userOps }, libraryService, libraryStore, { api }] =
  await setupIsolatedBackend(
    "canonical-favorites-route",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/subsonicLibraryService.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/routes/api.ts"),
  );

const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = libraryStore;

let user: NonNullable<ReturnType<typeof userOps.getUserById>>;
let artist: import("../../backend/db/rows.ts").LibraryArtistsRow;

beforeAll(() => {
  resetDatabase(db);
  const created = userOps.getUserById(userOps.createUser("native", "hash")!.id);
  assert.ok(created);
  user = created;
  artist = upsertLibraryArtist({
    identityKey: "favorite-artist",
    mbid: "11111111-1111-4111-8111-111111111111",
    name: "Favorite Artist",
    metadata: { genres: ["Indie Rock"] },
  });
  const album = upsertLibraryAlbum({
    identityKey: "favorite-album",
    mbid: "22222222-2222-4222-8222-222222222222",
    artistId: artist.id,
    title: "Favorite Album",
    albumArtist: artist.name,
  });
  const track = upsertLibraryTrack({
    identityKey: "favorite-track",
    mbid: "33333333-3333-4333-8333-333333333333",
    title: "Favorite Track",
    artistName: artist.name,
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: track.id,
    source: "aurral",
    path: "/library/Favorite Artist/Favorite Album/01 Favorite Track.flac",
    format: "flac",
    available: true,
  });
  const secondTrack = upsertLibraryTrack({
    identityKey: "favorite-track-two",
    mbid: "44444444-4444-4444-8444-444444444444",
    title: "Favorite Track Two",
    artistName: artist.name,
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: secondTrack.id, trackNumber: 2 });
  upsertLibraryMediaFile({
    trackId: secondTrack.id,
    source: "aurral",
    path: "/library/Favorite Artist/Favorite Album/02 Favorite Track Two.flac",
    format: "flac",
    available: false,
  });
  const otherArtist = upsertLibraryArtist({
    identityKey: "other-artist",
    name: "Other Artist",
    metadata: { genres: ["Jazz"] },
  });
  const otherAlbum = upsertLibraryAlbum({
    identityKey: "other-album",
    artistId: otherArtist.id,
    title: "Other Album",
    albumArtist: otherArtist.name,
  });
  const otherTrack = upsertLibraryTrack({
    identityKey: "other-track",
    title: "Other Track",
    artistName: otherArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: otherAlbum.id, trackId: otherTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: otherTrack.id,
    source: "aurral",
    path: "/library/Other Artist/Other Album/01 Other Track.flac",
    format: "flac",
    available: true,
  });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const library = (signedIn: RequestUser | undefined) => signedInAs(signedIn).route("/", api);

const pagePath = (query: Record<string, string>) =>
  `/library/canonical?${new URLSearchParams(query)}`;

const getFavorites = () => library(user).request("/library/favorites");

const getPage = (query: Record<string, string>) => library(user).request(pagePath(query));

const postLibrary = (path: string, body: unknown) =>
  library(user).request(`/library${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("native favorites return changed identities and reuse Subsonic star identity", async () => {
  const target = `artist:${encodeURIComponent(artist.identity_key)}`;
  const postResponse = await postLibrary("/favorites", { ids: [target], starred: true });

  assert.equal(postResponse.status, 200);
  const posted: FavoritesUpdate = await postResponse.json();
  assert.deepEqual(posted.changedIds, [target]);
  assert.equal("library" in posted, false);

  const favorites: Favorites = await (await getFavorites()).json();
  assert.deepEqual(
    favorites.artist.map((entry) => entry.id),
    [target],
  );
});

test("native favorites include the library favorite subset", async () => {
  const favorites: Favorites = await (await getFavorites()).json();

  assert.deepEqual(
    favorites.library.artists.map((entry) => entry.name),
    ["Favorite Artist"],
  );
  assert.deepEqual(
    favorites.library.albums.map((entry) => entry.title),
    ["Favorite Album"],
  );
  assert.deepEqual(
    favorites.library.tracks.map((entry) => entry.title),
    ["Favorite Track", "Favorite Track Two"],
  );
  assert.equal("path" in favorites.library.tracks[0].files[0], false);
});

test("library pages return bounded collection responses", async () => {
  const response = await getPage({
    kind: "tracks",
    page: "1",
    pageSize: "1",
    availableOnly: "false",
  });

  assert.equal(response.status, 200);
  const tracks: Page<"tracks"> = await response.json();
  assert.equal(tracks.kind, "tracks");
  assert.equal(tracks.page, 1);
  assert.equal(tracks.pageSize, 1);
  assert.equal(tracks.total, 3);
  assert.equal(tracks.items.length, 1);
  assert.equal(tracks.items[0].artistName, "Favorite Artist");
  assert.equal(String(tracks.items[0].canonicalId), String(tracks.items[0].id));
  assert.equal(tracks.items[0].providerId, null);
  assert.equal(tracks.items[0].source, "aurral");
  assert.equal(tracks.items[0].available, true);
  assert.equal(tracks.items[0].managedBy, null);
  assert.equal(tracks.items[0].monitorMode, null);
  assert.equal(tracks.albums[0].trackCount, 2);
  assert.equal(tracks.albums[0].availableTrackCount, 1);
  assert.equal(tracks.hasMore, true);
  assert.equal("path" in tracks.items[0].files[0], false);

  const available: Page<"albums"> = await (
    await getPage({ kind: "albums", page: "1", pageSize: "1", availableOnly: "true" })
  ).json();
  assert.equal(available.items[0].trackCount, 2);
  assert.equal(available.items[0].availableTrackCount, 1);
  assert.equal(String(available.items[0].canonicalId), String(available.items[0].id));
  assert.equal(available.items[0].source, "aurral");
  assert.equal(available.items[0].available, true);

  const artists: Page<"artists"> = await (
    await getPage({ kind: "artists", page: "1", pageSize: "1" })
  ).json();
  assert.equal(artists.items[0].userFavorite, true);
});

test("library rejects unbounded requests", async () => {
  const response = await getPage({ kind: "tracks" });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "kind and pageSize (1-100) are required");
});

test("native favorites rejects unknown targets without changing stars", async () => {
  const response = await postLibrary("/favorites", { ids: ["album:missing"], starred: true });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Invalid favorite target");
  assert.equal(libraryService.getStarred(user).artist.length, 1);
});

test("library pages filter, count, and paginate in the read query", async () => {
  const response = await library(undefined).request(
    pagePath({ kind: "albums", query: "Favorite", genre: "indie rock", page: "1", pageSize: "1" }),
  );

  assert.equal(response.status, 200);
  const albums: Page<"albums"> = await response.json();
  assert.equal(albums.total, 1);
  assert.equal(albums.hasMore, false);
  assert.equal(albums.items[0].title, "Favorite Album");
});

test("unfavoriting returns the removed stars so restoring keeps their original time", async () => {
  const first = `song:${encodeURIComponent("favorite-track")}`;
  const second = `song:${encodeURIComponent("favorite-track-two")}`;
  const starResponse = await postLibrary("/favorites", { ids: [first, second], starred: true });
  assert.equal(starResponse.status, 200);
  db.prepare(
    "UPDATE subsonic_stars SET created_at = 1000 WHERE user_id = ? AND entity_key = ?",
  ).run(user.id, "favorite-track");
  db.prepare(
    "UPDATE subsonic_stars SET created_at = 2000 WHERE user_id = ? AND entity_key = ?",
  ).run(user.id, "favorite-track-two");
  const storedSongs = () =>
    db
      .prepare<unknown[], { entity_key: string; created_at: number }>(
        "SELECT entity_key, created_at FROM subsonic_stars WHERE user_id = ? AND entity_kind = 'song' ORDER BY created_at",
      )
      .all(user.id);

  const unstarResponse = await postLibrary("/favorites", { ids: [first], starred: false });
  assert.equal(unstarResponse.status, 200);
  const unstarred: FavoritesUpdate = await unstarResponse.json();
  assert.deepEqual(unstarred.removed, [{ id: first, starredAt: 1000 }]);
  assert.deepEqual(storedSongs(), [{ entity_key: "favorite-track-two", created_at: 2000 }]);

  const rejected = await postLibrary("/favorites/restore", {
    favorites: [{ id: first, starredAt: "soon" }],
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(storedSongs(), [{ entity_key: "favorite-track-two", created_at: 2000 }]);

  const restoreResponse = await postLibrary("/favorites/restore", {
    favorites: unstarred.removed,
  });
  assert.equal(restoreResponse.status, 200);
  assert.deepEqual(storedSongs(), [
    { entity_key: "favorite-track", created_at: 1000 },
    { entity_key: "favorite-track-two", created_at: 2000 },
  ]);

  await postLibrary("/favorites", { ids: [first, second], starred: false });
  assert.deepEqual(storedSongs(), []);
});
