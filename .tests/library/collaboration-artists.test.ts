import { test, type TestContext } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../../backend/config/db-sqlite.ts";
import { getArtistLibraryLookup } from "../../backend/routes/library/handlers/misc.ts";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.ts";
import { libraryManager } from "../../backend/services/libraryManager.ts";
import { getLibraryPage } from "../../backend/services/libraryQueryService.ts";
import { getArtist, idFor } from "../../backend/services/subsonicLibraryService.ts";

const credit = "Carpenter Brut, Danger, The Toxic Avenger, LORN, Scattle, Waveshaper & Kn1ght";

async function createLibrary(t: TestContext, seed: number) {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-collaboration-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const id = (kind: string) => `${kind}0000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
  const lead = id("1");
  const solo = {
    path: path.join(root, "Carpenter Brut", "Trilogy", "01.flac"),
    common: {
      albumartist: "Carpenter Brut",
      album: "Trilogy",
      title: "Roller Mobster",
      musicbrainz_albumartistid: [lead],
      musicbrainz_releasegroupid: id("2"),
      musicbrainz_recordingid: id("3"),
    },
  };
  const danger = {
    path: path.join(root, "Danger", "09-09-09", "01.flac"),
    common: {
      albumartist: "Danger",
      album: "09/14 - 18/14",
      title: "11h30",
      musicbrainz_albumartistid: [id("6")],
      musicbrainz_releasegroupid: id("c"),
      musicbrainz_recordingid: id("d"),
    },
  };
  const soundtrack = {
    path: path.join(root, credit, "Furi", "01.flac"),
    common: {
      albumartist: credit,
      album: "Furi",
      title: "Time to Wake Up",
      musicbrainz_albumartistid: [lead, ...["6", "7", "8", "9", "a", "b"].map(id)],
      musicbrainz_releasegroupid: id("4"),
      musicbrainz_recordingid: id("5"),
    },
  };
  const untagged = {
    path: path.join(root, credit, "Furi", "02.flac"),
    common: {
      ...soundtrack.common,
      title: "Danger",
      musicbrainz_albumartistid: [],
      musicbrainz_recordingid: id("e"),
    },
  };
  for (const { path: filePath } of [solo, danger, soundtrack, untagged]) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "audio");
  }
  const scan = (files: (typeof solo)[]) =>
    scanMusicRoot({
      rootPath: root,
      filePaths: files.map((file) => file.path),
      force: true,
      syncSearch: false,
      metadataReader: async (filePath) => ({
        common: files.find((file) => file.path === filePath)?.common,
      }),
    });
  const albumOwners = () =>
    db
      .prepare<[string, string], { title: string; name: string; mbid: string | null }>(
        `SELECT album.title, artist.name, artist.mbid FROM library_albums AS album
         JOIN library_artists AS artist ON artist.id = album.artist_id
         WHERE album.release_group_mbid IN (?, ?)
         ORDER BY album.title`,
      )
      .all(solo.common.musicbrainz_releasegroupid, soundtrack.common.musicbrainz_releasegroupid);
  return { lead, solo, danger, soundtrack, untagged, scan, albumOwners };
}

const titles = (albums: { title?: string | null; name?: string | null }[]) =>
  albums.map((album) => album.title || album.name).sort();

test("a release credited to several artists gets its own artist instead of joining and renaming the first", async (t) => {
  const { lead, solo, soundtrack, scan, albumOwners } = await createLibrary(t, 1);

  await scan([solo, soundtrack]);

  assert.deepEqual(albumOwners(), [
    { title: "Furi", name: credit, mbid: null },
    { title: "Trilogy", name: "Carpenter Brut", mbid: lead },
  ]);
});

test("a full scan moves a release credited to several artists off the first artist it renamed", async (t) => {
  const { lead, solo, soundtrack, scan, albumOwners } = await createLibrary(t, 2);
  await scan([solo]);
  await scan([
    { ...soundtrack, common: { ...soundtrack.common, musicbrainz_albumartistid: [lead] } },
  ]);
  assert.deepEqual(albumOwners(), [
    { title: "Furi", name: credit, mbid: lead },
    { title: "Trilogy", name: credit, mbid: lead },
  ]);

  await scan([soundtrack, solo]);

  assert.deepEqual(albumOwners(), [
    { title: "Furi", name: credit, mbid: null },
    { title: "Trilogy", name: "Carpenter Brut", mbid: lead },
  ]);
});

test("a release credited to several artists shows under each credited artist in the library", async (t) => {
  const { lead, solo, danger, soundtrack, scan } = await createLibrary(t, 3);
  await scan([solo, soundtrack]);
  const leadArtist = db
    .prepare<[string], { id: number; identity_key: string }>(
      "SELECT id, identity_key FROM library_artists WHERE mbid = ?",
    )
    .get(lead);
  assert.ok(leadArtist);

  assert.deepEqual(titles((await getArtistLibraryLookup(lead)).albums), ["Furi", "Trilogy"]);
  assert.deepEqual(titles(await libraryManager.getAlbums(leadArtist.id)), ["Furi", "Trilogy"]);
  const page = getLibraryPage({ kind: "albums", artistId: leadArtist.id, pageSize: 10 });
  assert.deepEqual(titles(page.items), ["Furi", "Trilogy"]);
  assert.ok(
    page.items.find((album) => album.title === "Furi")?.creditedArtistMbids?.includes(lead),
  );
  assert.deepEqual(titles(getArtist(idFor("artist", leadArtist.identity_key))?.album ?? []), [
    "Furi",
    "Trilogy",
  ]);
  assert.equal(
    (await getArtistLibraryLookup(danger.common.musicbrainz_albumartistid[0])).exists,
    false,
  );

  await scan([danger]);

  assert.deepEqual(
    titles((await getArtistLibraryLookup(danger.common.musicbrainz_albumartistid[0])).albums),
    ["09/14 - 18/14", "Furi"],
  );
});

test("a track without artist IDs keeps the credits of its release", async (t) => {
  const { lead, solo, soundtrack, untagged, scan } = await createLibrary(t, 5);

  await scan([solo, soundtrack, untagged]);

  assert.deepEqual(titles((await getArtistLibraryLookup(lead)).albums), ["Furi", "Trilogy"]);
});

test("deleting a credited artist keeps a release credited to several artists", async (t) => {
  const { lead, solo, soundtrack, scan, albumOwners } = await createLibrary(t, 4);
  await scan([solo, soundtrack]);

  const deleted = await libraryManager.deleteArtist(lead, true, { manager: "aurral" });

  assert.equal(deleted.success, true);
  assert.deepEqual(albumOwners(), [{ title: "Furi", name: credit, mbid: null }]);
  await access(soundtrack.path);
});

test("credits come from album tags stored before an upgrade", (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dataDir = path.join(tmpdir(), `aurral-album-credits-${process.pid}`);
  t.onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  const run = (script: string) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AURRAL_DATA_DIR: dataDir,
        AURRAL_DB_PATH: path.join(dataDir, "aurral.db"),
      },
      encoding: "utf8",
    });
  const seeded = (ids: unknown, tag = "musicbrainz_albumartistid") =>
    JSON.stringify({ tags: { [tag]: ids } });
  run(`
    const { db } = await import("./backend/config/db-sqlite.ts");
    db.prepare("INSERT INTO library_artists (identity_key, name, created_at, updated_at) VALUES ('name:artist:credit', 'Credit', 1, 1)").run();
    const album = db.prepare("INSERT INTO library_albums (identity_key, artist_id, title, metadata_json, created_at, updated_at) VALUES (?, 1, ?, ?, 1, 1)");
    album.run("album:shared", "Shared", ${JSON.stringify(seeded(["AAAAAAAA-0000-4000-8000-000000000001", "not-an-id", "bbbbbbbb-0000-4000-8000-000000000002"]))});
    album.run("album:solo", "Solo", ${JSON.stringify(seeded(["cccccccc-0000-4000-8000-000000000003", "not-an-id"]))});
    album.run("album:tracks", "Tracks", ${JSON.stringify(seeded(["dddddddd-0000-4000-8000-000000000004", "eeeeeeee-0000-4000-8000-000000000005"], "musicbrainz_artistid"))});
    album.run("album:broken", "Broken", "{");
    db.prepare("DELETE FROM settings WHERE key = 'migration:album-credits-v1'").run();
  `);

  const credits = JSON.parse(
    run(`
      const { db } = await import("./backend/config/db-sqlite.ts");
      process.stdout.write(JSON.stringify(db.prepare(
        "SELECT album.title, credit.artist_mbid FROM library_album_credits AS credit JOIN library_albums AS album ON album.id = credit.album_id ORDER BY credit.artist_mbid",
      ).all()));
    `),
  );

  assert.deepEqual(credits, [
    { title: "Shared", artist_mbid: "aaaaaaaa-0000-4000-8000-000000000001" },
    { title: "Shared", artist_mbid: "bbbbbbbb-0000-4000-8000-000000000002" },
    { title: "Tracks", artist_mbid: "dddddddd-0000-4000-8000-000000000004" },
    { title: "Tracks", artist_mbid: "eeeeeeee-0000-4000-8000-000000000005" },
  ]);
});
