import assert from "node:assert/strict";
import { afterAll, test } from "vite-plus/test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";
import { parseShareManifest } from "../../lib/shareManifest.ts";

const [paths, { db }, media, { shareDestination }] = await setupIsolatedBackend(
  "share-open",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/shareLinks/open.ts"),
);
afterAll(() => cleanupIsolatedState(paths));
const artistMbid = "11111111-1111-4111-8111-111111111111";
const albumMbid = "22222222-2222-4222-8222-222222222222";
const trackMbid = "33333333-3333-4333-8333-333333333333";
const artist = media.upsertLibraryArtist({
  identityKey: `mbid:${artistMbid}`,
  mbid: artistMbid,
  name: "Tycho",
});
const album = media.upsertLibraryAlbum({
  identityKey: `release-group:${albumMbid}`,
  releaseGroupMbid: albumMbid,
  artistId: artist.id,
  title: "Dive",
});
const compilation = media.upsertLibraryAlbum({
  identityKey: "album:compilation",
  artistId: artist.id,
  title: "Compilation",
});
const track = media.upsertLibraryTrack({
  identityKey: `recording:${trackMbid}`,
  mbid: trackMbid,
  title: "A Walk",
  artistName: "Tycho",
});
media.linkLibraryAlbumTrack({ albumId: compilation.id, trackId: track.id });
media.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });

test("opening a share finds recipient Library IDs without importing or acquiring music", () => {
  const requests = [
    { kind: "artist", title: "Tycho", artistName: "Tycho", artistMbid },
    { kind: "album", title: "Dive", artistName: "Tycho", albumMbid },
    {
      kind: "track",
      title: "A Walk",
      artistName: "Tycho",
      albumTitle: "Dive",
      trackMbid,
      albumMbid,
    },
  ];
  const before = db.prepare("SELECT COUNT(*) AS count FROM library_tracks").get();
  const destinations = requests.map((input) => {
    const manifest = parseShareManifest(input);
    assert.ok(manifest);
    return shareDestination(manifest);
  });
  assert.deepEqual(destinations, [
    `/library/artist/${artist.id}`,
    `/library/album/${album.id}`,
    `/library/album/${album.id}?track=${track.id}`,
  ]);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM library_tracks").get(), before);
  assert.equal(db.prepare("SELECT 1 FROM playlist_download_jobs LIMIT 1").get(), undefined);
});

test("name-only shares open the matching local artist, album and track", () => {
  for (const [kind, title, expected] of [
    ["artist", "Tycho", `/library/artist/${artist.id}`],
    ["album", "Dive", `/library/album/${album.id}`],
    ["track", "A Walk", `/library/album/${album.id}?track=${track.id}`],
  ]) {
    const manifest = parseShareManifest({ kind, title, artistName: "Tycho", albumTitle: "Dive" });
    assert.ok(manifest);
    assert.equal(shareDestination(manifest), expected);
  }
});

test("a missing performer uses the album artist without overriding an explicit credit", () => {
  for (const { title, artistName } of [
    { title: "No credit", artistName: null },
    { title: "Guest credit", artistName: "Guest" },
  ]) {
    const local = media.upsertLibraryTrack({
      identityKey: `track:${title}`,
      title,
      artistName,
    });
    media.linkLibraryAlbumTrack({ albumId: album.id, trackId: local.id });
    const manifest = parseShareManifest({
      kind: "track",
      title,
      artistName: "Tycho",
      albumTitle: "Dive",
    });
    assert.ok(manifest);
    assert.equal(
      shareDestination(manifest),
      artistName
        ? "/search?q=Guest%20credit%20Tycho"
        : `/library/album/${album.id}?track=${local.id}`,
    );
  }
});

test("unowned items open discovery or search without creating Library entries", () => {
  const unknownArtist = "44444444-4444-4444-8444-444444444444";
  const inputs = [
    [
      {
        kind: "artist",
        title: "Another artist",
        artistName: "Another artist",
        artistMbid: unknownArtist,
      },
      `/artist/${unknownArtist}`,
    ],
    [
      {
        kind: "album",
        title: "Another album",
        artistName: "Another artist",
        artistMbid: unknownArtist,
        albumMbid: "55555555-5555-4555-8555-555555555555",
      },
      `/artist/${unknownArtist}/release/55555555-5555-4555-8555-555555555555`,
    ],
    [
      { kind: "track", title: "Unknown song", artistName: "Another artist" },
      "/search?q=Unknown%20song%20Another%20artist",
    ],
  ] as const;
  for (const [input, to] of inputs) {
    const manifest = parseShareManifest(input);
    assert.ok(manifest);
    assert.equal(shareDestination(manifest), to);
  }
});

test("conflicting MusicBrainz IDs never resolve by artist or album name", () => {
  const differentArtist = "44444444-4444-4444-8444-444444444444";
  const differentAlbum = "55555555-5555-4555-8555-555555555555";
  const cases = [
    [
      { kind: "artist", title: "Tycho", artistName: "Tycho", artistMbid: differentArtist },
      `/artist/${differentArtist}`,
    ],
    [
      { kind: "album", title: "Dive", artistName: "Tycho", artistMbid, albumMbid: differentAlbum },
      `/artist/${artistMbid}/release/${differentAlbum}`,
    ],
    [
      {
        kind: "album",
        title: "Compilation",
        artistName: "Tycho",
        artistMbid,
        albumMbid: differentAlbum,
      },
      `/library/album/${compilation.id}`,
    ],
  ] as const;
  for (const [input, expected] of cases) {
    const manifest = parseShareManifest(input);
    assert.ok(manifest);
    assert.equal(shareDestination(manifest), expected);
  }
});
