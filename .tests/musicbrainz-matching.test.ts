import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, test, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";

vi.mock("../backend/services/apiClients/rateLimiter.ts", async (importOriginal) => {
  const { default: createRateLimiter } =
    await importOriginal<typeof import("../backend/services/apiClients/rateLimiter.ts")>();
  return {
    default: (_minTime: number, options: Parameters<typeof createRateLimiter>[1]) =>
      createRateLimiter(0, options),
  };
});
vi.mock("../backend/services/metadataProviderBudget.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend/services/metadataProviderBudget.ts")>()),
  reserveMetadataProviderRequest: () => 0,
}));

const [isolatedState, { db }, { dbOps }, libraryStore, provider, indexService, artistMatch] =
  await setupIsolatedBackend(
    "musicbrainz-matching",
    () => import("../backend/config/db-sqlite.ts"),
    () => import("../backend/db/helpers/index.ts"),
    () => import("../backend/services/libraryMediaStore.ts"),
    () => import("../backend/services/providers/brainzmashProvider.ts"),
    () => import("../backend/services/libraryIndexService.ts"),
    () => import("../backend/services/artistMatch.ts"),
  );

const GRUNGE = "66666666-6666-4666-8666-666666666601";
const SIXTIES = "66666666-6666-4666-8666-666666666602";
const NEVERMIND = "66666666-6666-4666-8666-666666666611";
const BLEACH = "66666666-6666-4666-8666-666666666612";

const grunge = { id: GRUNGE, artistname: "Nirvana", albums: ["Nevermind", "In Utero"] };
const sixties = {
  id: SIXTIES,
  artistname: "Nirvana",
  disambiguation: "60s band from the UK",
  images: [{ CoverType: "Poster", Url: "https://images.test/nirvana-uk.jpg" }],
  albums: ["The Story of Simon Simopath", "Local Anaesthetic"],
};
const artists = new Map([grunge, sixties].map((artist) => [artist.id, artist]));
const nevermindSongs = ["Smells Like Teen Spirit", "In Bloom", "Come as You Are"];
let searchAvailable = true;
let albumSearches = 0;

const server = await createMockHttpServer((request, response) => {
  const url = new URL(request.url || "/", "http://provider.test");
  const reply = (status: number, body?: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  if (url.pathname === "/search/artist") {
    if (!searchAvailable) return reply(400);
    return reply(200, url.searchParams.get("query") === "Nirvana" ? [grunge, sixties] : []);
  }
  if (url.pathname === "/search/album") {
    albumSearches += 1;
    const query = url.searchParams.get("query") || "";
    if (query.startsWith("Bleach")) {
      return reply(200, [{ id: BLEACH, title: "Bleach", artistid: GRUNGE, artists: [grunge] }]);
    }
    return reply(
      200,
      query.startsWith("Nevermind")
        ? [{ id: NEVERMIND, title: "Nevermind", artistid: GRUNGE, artists: [grunge] }]
        : [],
    );
  }
  if (url.pathname === `/album/${BLEACH}`) return reply(503);
  if (url.pathname === `/album/${NEVERMIND}`) {
    return reply(200, {
      id: NEVERMIND,
      title: "Nevermind",
      artistid: GRUNGE,
      artists: [grunge],
      releases: [
        {
          id: `${NEVERMIND}-release`,
          status: "Official",
          tracks: nevermindSongs.map((trackname, index) => ({
            id: `nevermind-track-${index + 1}`,
            recordingid: `66666666-6666-4666-8666-6666666667${String(index + 1).padStart(2, "0")}`,
            trackname,
            trackposition: index + 1,
            mediumnumber: 1,
            artistid: GRUNGE,
          })),
        },
      ],
    });
  }
  const artist = artists.get(url.pathname.replace(/^\/artist\//, ""));
  if (!artist) return reply(404);
  return reply(200, {
    ...artist,
    Albums: artist.albums.map((title, index) => ({
      Id: `${artist.id}-album-${index}`,
      Title: title,
      Type: "Album",
    })),
  });
});

const settings = dbOps.getSettings();
const musicRoot = await mkdtemp(path.join(tmpdir(), "aurral-musicbrainz-matching-"));

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      metadata: {
        ...settings.integrations?.metadata,
        baseUrl: server.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  searchAvailable = true;
  albumSearches = 0;
  provider.clearMetadataProviderCaches();
});

afterAll(async () => {
  await server.close();
  await rm(musicRoot, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

function libraryArtist(name: string, albums: string[]) {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: libraryStore.buildFallbackIdentityKey("artist", name),
    name,
  });
  albums.forEach((title, index) => {
    const album = libraryStore.upsertLibraryAlbum({
      identityKey: `${name}-album-${index}`,
      artistId: artist.id,
      title,
    });
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `${name}-track-${index}`,
      title: `${title} Track`,
      artistName: name,
    });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "lidarr",
      path: `/library/${name}/${index}.flac`,
      available: true,
    });
  });
  return artist.id;
}

const scan = (options: { force?: boolean } = {}) =>
  indexService.scanConfiguredLibrary({
    musicRoot,
    includeLidarr: false,
    lidarrClient: { isConfigured: () => true },
    ...options,
  });

function untaggedAlbum(title: string, songs: string[]) {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${GRUNGE}`,
    mbid: GRUNGE,
    name: "Nirvana",
  });
  const albumKey = libraryStore.buildFallbackIdentityKey("album", `mbid:${GRUNGE}`, title);
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: albumKey,
    artistId: artist.id,
    title,
  });
  songs.forEach((song, index) => {
    const track = libraryStore.upsertLibraryTrack({
      identityKey: libraryStore.buildFallbackIdentityKey("track", albumKey, 1, index + 1, song),
      title: song,
      artistName: "Nirvana",
    });
    libraryStore.linkLibraryAlbumTrack({
      albumId: album.id,
      trackId: track.id,
      trackNumber: index + 1,
    });
    libraryStore.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "lidarr",
      path: `/library/Nirvana/${title}/${index + 1}.flac`,
      available: true,
    });
  });
  return album.id;
}

const albumRow = (albumId: number) =>
  db
    .prepare<[number], { identity_key: string; release_group_mbid: string | null }>(
      "SELECT identity_key, release_group_mbid FROM library_albums WHERE id = ?",
    )
    .get(albumId);

const albumSongs = (albumId: number) =>
  db
    .prepare<[number], { title: string; hasFile: number }>(
      `SELECT track.title, EXISTS (
         SELECT 1 FROM library_media_files AS media WHERE media.track_id = track.id
       ) AS hasFile
       FROM library_album_tracks AS link
       JOIN library_tracks AS track ON track.id = link.track_id
       WHERE link.album_id = ?
       ORDER BY link.track_number`,
    )
    .all(albumId)
    .map((song) => [song.title, Boolean(song.hasFile)]);

const mbidOf = (artistId: number) =>
  db
    .prepare<[number], { mbid: string | null }>("SELECT mbid FROM library_artists WHERE id = ?")
    .get(artistId)?.mbid;

test("an untagged Library artist links to the namesake whose discography has its albums", async () => {
  const artistId = libraryArtist("Nirvana", ["Local Anaesthetic (Remastered)"]);

  await scan();

  assert.equal(mbidOf(artistId), SIXTIES);
});

test("an untagged Library artist links through store labels and featured credits", async () => {
  const labeled = libraryArtist("Nirvana", ["Local Anaesthetic - Single"]);
  const featuring = libraryArtist("Nirvana feat. Someone", ["Nevermind"]);

  await scan();

  assert.equal(mbidOf(labeled), SIXTIES);
  assert.equal(mbidOf(featuring), GRUNGE);
});

test("an untagged Library artist stays unlinked when no namesake has its albums", async () => {
  const artistId = libraryArtist("Nirvana", ["Bootleg Nobody Released"]);

  await scan();

  assert.equal(mbidOf(artistId), null);
});

test("a guess takes the best-known artist of a name, or the namesake with the album it came with", async () => {
  assert.equal(await artistMatch.guessArtistMbid("Nirvana"), GRUNGE);
  assert.equal(
    await artistMatch.guessArtistMbid("Nirvana", { album: "Local Anaesthetic" }),
    SIXTIES,
  );
  assert.equal(await artistMatch.guessArtistMbid("Nirvana feat. Someone"), GRUNGE);
});

test("a guess the provider could not answer is tried again next time", async () => {
  searchAvailable = false;
  assert.equal(await artistMatch.guessArtistMbid("Nirvana"), null);

  searchAvailable = true;
  assert.equal(await artistMatch.guessArtistMbid("Nirvana"), GRUNGE);
});

test("an album title that names an edition matches the album", async () => {
  assert.equal(
    await provider.resolveAlbumByArtistAndTitle({
      artistName: "Nirvana",
      albumTitle: "Nevermind (Remastered)",
    }),
    NEVERMIND,
  );
});

test("an untagged album of a linked artist takes the release group that holds its songs", async () => {
  const albumId = untaggedAlbum("Nevermind (Remastered)", ["Smells Like Teen Spirit", "In Bloom"]);

  await scan();

  assert.deepEqual(albumRow(albumId), {
    identity_key: `release-group:${NEVERMIND}`,
    release_group_mbid: NEVERMIND,
  });
  assert.deepEqual(albumSongs(albumId), [
    ["Smells Like Teen Spirit", true],
    ["In Bloom", true],
    ["Come as You Are", false],
  ]);
});

test("an untagged album joins the Library's album of the release group it matches", async () => {
  const taggedId = untaggedAlbum("Nevermind", ["Come as You Are"]);
  libraryStore.rekeyLibraryAlbum(taggedId, `release-group:${NEVERMIND}`);
  db.prepare("UPDATE library_albums SET release_group_mbid = ? WHERE id = ?").run(
    NEVERMIND,
    taggedId,
  );
  const untaggedId = untaggedAlbum("Nevermind (Remastered)", ["Smells Like Teen Spirit"]);

  await scan();

  assert.equal(albumRow(untaggedId), undefined);
  assert.deepEqual(albumSongs(taggedId), [
    ["Smells Like Teen Spirit", true],
    ["In Bloom", false],
    ["Come as You Are", true],
  ]);
});

test("an untagged album no release group holds is looked up again when asked or when its songs change", async () => {
  const albumId = untaggedAlbum("Nevermind", ["Demo One", "Demo Two"]);

  await scan();
  provider.clearMetadataProviderCaches();
  const searched = albumSearches;
  await scan();

  assert.equal(albumRow(albumId)?.release_group_mbid, null);
  assert.ok(searched > 0);
  assert.equal(albumSearches, searched);

  await scan({ force: true });
  assert.ok(albumSearches > searched);

  const tagRecording = db.prepare<[string, string]>(
    "UPDATE library_tracks SET mbid = ? WHERE title = ?",
  );
  tagRecording.run("66666666-6666-4666-8666-666666666701", "Demo One");
  tagRecording.run("66666666-6666-4666-8666-666666666702", "Demo Two");
  await scan();

  assert.equal(albumRow(albumId)?.release_group_mbid, NEVERMIND);
});

test("an untagged album whose lookup is cooling down does not hold up the others", async () => {
  const cooling = untaggedAlbum("Bleach", ["Blew"]);
  const matched = untaggedAlbum("Nevermind", ["Smells Like Teen Spirit", "In Bloom"]);

  await scan();
  await scan();

  assert.equal(albumRow(cooling)?.release_group_mbid, null);
  assert.equal(albumRow(matched)?.release_group_mbid, NEVERMIND);
});
