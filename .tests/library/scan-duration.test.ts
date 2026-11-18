import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFile, type IOptions } from "music-metadata";

import { db } from "../../backend/config/db-sqlite.ts";
import { readScannedMetadata, scanMusicRoot } from "../../backend/services/libraryFileScanner.ts";
import { buildOggOpus } from "../helpers/oggOpusFixture.ts";

type Reply = { common?: Record<string, unknown>; format?: { duration?: number } };

// Answers the quick pass and the duration pass separately and records each call's options.
function scriptedReader(quick: Reply, full: Reply | Error) {
  const calls: IOptions[] = [];
  const reader = async (_filePath: string, options: IOptions) => {
    calls.push(options);
    if (!options.duration) return quick;
    if (full instanceof Error) throw full;
    return full;
  };
  return { reader, calls };
}

function storedDurationMs(source: string, filePath: string) {
  const row = db
    .prepare<[string, string], { duration_ms: number | null }>(
      "SELECT duration_ms FROM library_media_files WHERE source = ? AND path = ?",
    )
    .get(source, filePath);
  assert.ok(row, "the file should have been indexed");
  return row.duration_ms;
}

async function withScannedFile(
  name: string,
  contents: Uint8Array | string,
  run: (context: { root: string; source: string; filePath: string }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-scan-duration-"));
  const source = `scan-duration-${process.pid}`;
  const filePath = path.join(root, "Duration Artist", "Duration Album", name);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
    await run({ root, source, filePath });
  } finally {
    await rm(root, { recursive: true, force: true });
    db.prepare("DELETE FROM library_media_files WHERE source = ?").run(source);
  }
}

test("a scan stores the duration of an Ogg Opus file longer than the quick pass reads", async () => {
  await withScannedFile("01 Opus Track.opus", buildOggOpus({ seconds: 3 }), async (file) => {
    await scanMusicRoot({ rootPath: file.root, source: file.source });

    // 3 seconds, to the millisecond: the Opus pre-skip is taken off the last granule position.
    assert.equal(storedDurationMs(file.source, file.filePath), 3000);
  });
});

test("the quick pass alone reports no duration for that Opus file", async () => {
  await withScannedFile("01 Opus Track.opus", buildOggOpus({ seconds: 3 }), async (file) => {
    // Pins the behaviour behind the fix, so the test above fails if the fixture stops covering it.
    const quick = await parseFile(file.filePath, { skipCovers: true });
    assert.equal(quick.format.duration, undefined);
  });
});

test("the duration pass is skipped when the quick pass already knows the duration", async () => {
  const { reader, calls } = scriptedReader({ format: { duration: 200 } }, { format: {} });

  const metadata = await readScannedMetadata(reader, "/music/a.flac");

  assert.equal(metadata.format?.duration, 200);
  assert.deepEqual(calls, [{ skipCovers: true }]);
});

test("the duration pass runs once, with covers skipped, when the quick pass finds none", async () => {
  const { reader, calls } = scriptedReader({ format: {} }, { format: { duration: 187.5 } });

  const metadata = await readScannedMetadata(reader, "/music/a.ogg");

  assert.equal(metadata.format?.duration, 187.5);
  assert.deepEqual(calls, [{ skipCovers: true }, { skipCovers: true, duration: true }]);
});

test("a zero or invalid quick-pass duration also triggers the duration pass", async () => {
  for (const duration of [0, Number.NaN]) {
    const { reader, calls } = scriptedReader(
      { format: { duration } },
      { format: { duration: 61 } },
    );

    const metadata = await readScannedMetadata(reader, "/music/a.ogg");

    assert.equal(metadata.format?.duration, 61);
    assert.equal(calls.length, 2);
  }
});

test("a failing duration pass keeps what the quick pass read", async () => {
  const quick = { common: { title: "Kept" }, format: {} };
  const { reader } = scriptedReader(quick, new Error("truncated file"));

  const metadata = await readScannedMetadata(reader, "/music/a.ogg");

  assert.equal(metadata, quick);
});

test("a failing quick pass still fails the file", async () => {
  const reader = async () => {
    throw new Error("not audio");
  };

  await assert.rejects(readScannedMetadata(reader, "/music/a.ogg"), /not audio/);
});

test("a file with no duration at all is still indexed, with no length", async () => {
  await withScannedFile("01 Tagless.ogg", "fixture", async (file) => {
    const { reader } = scriptedReader({ common: { title: "Tagless" }, format: {} }, { format: {} });

    await scanMusicRoot({ rootPath: file.root, source: file.source, metadataReader: reader });

    assert.equal(storedDurationMs(file.source, file.filePath) || 0, 0);
  });
});
