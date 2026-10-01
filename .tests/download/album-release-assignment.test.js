import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignDownloadedAlbumFiles } from "../../backend/services/albumReleaseAssignment.js";

test("album assignment fills only verified sibling jobs and never reuses a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "aurral-album-assignment-"));
  try {
    const paths = ["02 Second.flac", "01 First.flac", "03 First (Live).flac"]
      .map((name) => join(root, name));
    for (const filePath of paths) await writeFile(filePath, "fixture");
    const parsed = new Map([
      [paths[0], { common: { title: "Second", artist: "The Band", track: { no: 2 } },
        format: { duration: 201, lossless: true, sampleRate: 44100, bitsPerSample: 16, container: "FLAC" } }],
      [paths[1], { common: { title: "First", artist: "The Band", track: { no: 1 } },
        format: { duration: 200, lossless: true, sampleRate: 44100, bitsPerSample: 16, container: "FLAC" } }],
      [paths[2], { common: { title: "First (Live)", artist: "The Band", track: { no: 3 } },
        format: { duration: 200, lossless: true, sampleRate: 44100, bitsPerSample: 16, container: "FLAC" } }],
    ]);
    const jobs = [
      { id: "first", trackName: "First", artistName: "The Band", albumName: "Album", durationMs: 200000, trackNumber: 1 },
      { id: "second", trackName: "Second", artistName: "The Band", albumName: "Album", durationMs: 201000, trackNumber: 2 },
      { id: "third", trackName: "Third", artistName: "The Band", albumName: "Album", durationMs: 202000, trackNumber: 3 },
    ];
    const result = await assignDownloadedAlbumFiles({
      jobs, filePaths: [...paths, paths[0], join(root, "missing.flac")], source: "deemix",
      parseAudio: async (filePath) => parsed.get(filePath),
    });
    assert.deepEqual(result.accepted.map(({ jobId }) => jobId), ["first", "second"]);
    assert.deepEqual(result.unassignedJobIds, ["third"]);
    assert.equal(new Set(result.accepted.map(({ filePath }) => filePath)).size, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
