import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import taglib from "node-taglib-sharp";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { json, stubFetch } from "../helpers/stubFetch.ts";
import { useFakeClock } from "../helpers/fakeClock.ts";

useFakeClock();

const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-artist-credits-"));
const [isolatedState, { writeAudioMetadata }] = await setupIsolatedBackend(
  "download-artist-credits",
  () => import("../../backend/services/downloadUtils.ts"),
);
const KENDRICK = "381086ea-f511-4aba-bdf9-71c753dc5077";
const SZA = "272989c8-5535-492d-a25c-9f58803e027f";
const job = {
  trackName: "All the Stars",
  artistName: "Kendrick Lamar",
  albumName: "Black Panther: The Album",
  artistMbid: KENDRICK,
  albumMbid: "1d1b6b93-1b3c-4ac6-ad2b-a4bdbc5ae1b5",
  trackMbid: "5d7d5e5b-3e0a-4b83-9a43-6b2fa2a1d6a1",
};

function makeAudio(name: string, codec: string[]) {
  const filePath = path.join(tempDir, name);
  const result = spawnSync(
    "ffmpeg",
    ["-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "anullsrc", "-t", "0.2"]
      .concat(codec)
      .concat(["-metadata", "artist=Kendrick Lamar", filePath]),
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return filePath;
}

const isReleaseBrowse = (url: URL, albumMbid: string) =>
  url.hostname === "musicbrainz.org" &&
  url.pathname === "/ws/2/release" &&
  url.searchParams.get("release-group") === albumMbid;

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
  await rm(tempDir, { recursive: true, force: true });
});

test("a download reads guest credits from v1 album metadata without calling MusicBrainz", async (t) => {
  const releaseMbid = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5";
  const albumMbid = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
  let mbLookups = 0;
  stubFetch(t, (url) => {
    if (url.hostname === "musicbrainz.org") {
      mbLookups += 1;
      return json({}, 404);
    }
    if (url.pathname === `/v1/album/${albumMbid}`) {
      return json({
        id: albumMbid,
        title: job.albumName,
        artistId: KENDRICK,
        artists: [
          { id: KENDRICK, name: "Kendrick Lamar" },
          { id: SZA, name: "SZA" },
        ],
        releases: [
          {
            id: releaseMbid,
            status: "Official",
            tracks: [
              {
                id: "track-1",
                recordingId: job.trackMbid,
                title: job.trackName,
                trackPosition: 1,
                mediumNumber: 1,
                artistId: KENDRICK,
                credits: [
                  { id: KENDRICK, name: "Kendrick Lamar", joinPhrase: " & " },
                  { id: SZA, name: "SZA", joinPhrase: "" },
                ],
              },
            ],
          },
        ],
      });
    }
    return json({}, 404);
  });
  const files = [
    makeAudio("stars.mp3", ["-c:a", "libmp3lame"]),
    makeAudio("stars.flac", ["-c:a", "flac"]),
    makeAudio("stars.m4a", ["-c:a", "aac"]),
  ];

  for (const filePath of files) {
    await writeAudioMetadata(filePath, { ...job, albumMbid, releaseMbid });
  }

  assert.equal(mbLookups, 0);
  for (const filePath of files) {
    const { common } = await parseFile(filePath);
    assert.equal(common.artist, "Kendrick Lamar & SZA", filePath);
    assert.deepEqual(common.artists, ["Kendrick Lamar", "SZA"], filePath);
    assert.deepEqual(common.musicbrainz_artistid, [KENDRICK, SZA], filePath);
    assert.equal(common.albumartist, "Kendrick Lamar", filePath);
    assert.equal(common.musicbrainz_albumartistid?.[0], KENDRICK, filePath);
  }
});

test("a download fills guest credits from the MusicBrainz album fallback once per album when the album file is missing", async (t) => {
  const albumMbid = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0";
  const releaseMbid = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
  let releaseBrowseCalls = 0;
  stubFetch(t, (url) => {
    if (url.hostname === "musicbrainz.org" && url.pathname === `/ws/2/release-group/${albumMbid}`) {
      return json({
        id: albumMbid,
        title: job.albumName,
        "primary-type": "Album",
        "artist-credit": [
          { name: "Kendrick Lamar", artist: { id: KENDRICK, name: "Kendrick Lamar" } },
        ],
      });
    }
    if (isReleaseBrowse(url, albumMbid)) {
      releaseBrowseCalls += 1;
      return json({
        releases: [
          {
            id: releaseMbid,
            title: job.albumName,
            status: "Official",
            media: [
              {
                position: 1,
                tracks: [
                  {
                    id: "t-1",
                    position: 1,
                    title: job.trackName,
                    "artist-credit": [
                      { name: "Kendrick Lamar", joinphrase: " & ", artist: { id: KENDRICK } },
                      { name: "SZA", joinphrase: "", artist: { id: SZA } },
                    ],
                    recording: { id: job.trackMbid },
                  },
                ],
              },
            ],
          },
        ],
      });
    }
    return json({}, 404);
  });
  const files = [
    makeAudio("mb-1.flac", ["-c:a", "flac"]),
    makeAudio("mb-2.flac", ["-c:a", "flac"]),
  ];

  for (const filePath of files) {
    await writeAudioMetadata(filePath, { ...job, albumMbid, releaseMbid });
  }

  assert.equal(releaseBrowseCalls, 1);
  for (const filePath of files) {
    const { common } = await parseFile(filePath);
    assert.equal(common.artist, "Kendrick Lamar & SZA", filePath);
    assert.deepEqual(common.artists, ["Kendrick Lamar", "SZA"], filePath);
    assert.deepEqual(common.musicbrainz_artistid, [KENDRICK, SZA], filePath);
  }
});

test("a download keeps its album artist when album metadata is unavailable", async (t) => {
  const albumMbid = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
  const releaseMbid = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
  stubFetch(t, () => json({}, 500));
  const filePath = makeAudio("down-1.flac", ["-c:a", "flac"]);

  await writeAudioMetadata(filePath, { ...job, albumMbid, releaseMbid });

  const { common } = await parseFile(filePath);
  assert.equal(common.artist, "Kendrick Lamar");
  assert.deepEqual(common.musicbrainz_artistid, [KENDRICK]);
});

test("re-tagging a file with a credit for one artist replaces an uploader's list of others", async (t) => {
  const albumMbid = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
  const releaseMbid = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
  stubFetch(t, (url) =>
    url.pathname === `/v1/album/${albumMbid}`
      ? json({
          id: albumMbid,
          title: job.albumName,
          artistId: KENDRICK,
          artists: [{ id: KENDRICK, name: "Kendrick Lamar" }],
          releases: [
            {
              id: releaseMbid,
              status: "Official",
              tracks: [
                {
                  id: "track-1",
                  recordingId: job.trackMbid,
                  title: job.trackName,
                  artistId: KENDRICK,
                },
              ],
            },
          ],
        })
      : json({}, 404),
  );
  const filePath = makeAudio("solo.flac", ["-c:a", "flac"]);
  const file = taglib.File.createFromPath(filePath);
  (file.getTag(taglib.TagTypes.Xiph, true) as taglib.XiphComment).setFieldAsStrings(
    "ARTISTS",
    "Kendrick Lamar",
    "Someone Else",
  );
  file.save();
  file.dispose();

  await writeAudioMetadata(filePath, { ...job, albumMbid, releaseMbid });

  const { common } = await parseFile(filePath);
  assert.deepEqual(common.artists, ["Kendrick Lamar"]);
});

test("a track request takes its album artist from the album's main artist", async (t) => {
  const releaseMbid = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
  const albumMbid = "fce8fe8b-9402-3893-b4a2-5bacefdb8f1f";
  const albumArtist = "11bf566b-a73e-4e8c-ba82-83fdcddd0aed";
  const performer = "f98a61b4-0000-4000-8000-000000000001";
  stubFetch(t, (url) =>
    url.pathname === `/v1/album/${albumMbid}`
      ? json({
          id: albumMbid,
          title: "Hôtel Costes 9",
          artistId: albumArtist,
          artists: [
            { id: performer, name: "One Self" },
            { id: albumArtist, name: "Stéphane Pompougnac" },
          ],
          genres: ["downtempo"],
          releases: [
            {
              id: releaseMbid,
              status: "Official",
              tracks: [
                {
                  id: "track-1",
                  recordingId: job.trackMbid,
                  title: "Bluebird",
                  artistId: performer,
                },
              ],
            },
          ],
        })
      : json({}, 404),
  );
  const filePath = makeAudio("bluebird.flac", ["-c:a", "flac"]);

  await writeAudioMetadata(filePath, {
    ...job,
    artistName: "One Self",
    albumName: "Hôtel Costes 9",
    albumMbid,
    artistMbid: performer,
    trackName: "Bluebird",
    releaseMbid,
  });

  const { common } = await parseFile(filePath);
  assert.equal(common.artist, "One Self");
  assert.equal(common.albumartist, "Stéphane Pompougnac");
  assert.equal(common.musicbrainz_albumartistid?.[0], albumArtist);
});
