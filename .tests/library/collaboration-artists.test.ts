import { test, type TestContext } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "../../backend/config/db-sqlite.ts";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.ts";

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
  for (const { path: filePath } of [solo, soundtrack]) {
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
  return { lead, solo, soundtrack, scan, albumOwners };
}

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
