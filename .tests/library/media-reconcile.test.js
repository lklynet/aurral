import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { collectMissingIndexedPaths } from "../../backend/services/libraryFileScanner.js";

const root = path.join(path.sep, "music");
const trackPath = (index) =>
  path.join(root, `Artist ${index}`, `Album ${index}`, `01 Track ${index}.flac`);

test("reconcile keeps indexed files that a directory scan no longer saw", () => {
  const present = trackPath(1);
  const removed = trackPath(2);
  const untouched = path.join(path.sep, "other-root", "Artist", "Album", "01 Track.flac");

  const missing = collectMissingIndexedPaths({
    indexedPaths: new Set([present, removed, untouched]),
    scopes: [path.dirname(present), path.dirname(removed)],
    scopesAreDirectories: true,
    seenPaths: new Set([present]),
    failedPaths: new Set(),
  });

  assert.deepEqual(missing, [removed]);
});

test("reconcile ignores an indexed file whose scan failed rather than marking it missing", () => {
  const failed = trackPath(3);

  const missing = collectMissingIndexedPaths({
    indexedPaths: new Set([failed]),
    scopes: [failed],
    scopesAreDirectories: false,
    seenPaths: new Set(),
    failedPaths: new Set([failed]),
  });

  assert.deepEqual(missing, []);
});

test("reconcile matches file scopes exactly instead of by path containment", () => {
  const requested = trackPath(4);
  const sibling = trackPath(5);

  const missing = collectMissingIndexedPaths({
    indexedPaths: new Set([requested, sibling]),
    scopes: [requested],
    scopesAreDirectories: false,
    seenPaths: new Set(),
    failedPaths: new Set(),
  });

  assert.deepEqual(missing, [requested]);
});

// A whole-library scan passes every audio file as its own scope, so the reconcile step
// sees N indexed paths and N scopes. Comparing each pair with path.relative() is O(n²)
// and blocks the event loop: on a 17k-file library it pinned one core for over eight
// minutes, and every request Aurral received in that window timed out. Every scanned
// file is already in seenPaths, so the cheap Set lookups decide the result on their own.
// This test fails by timeout if the expensive containment check runs first again.
test("reconcile stays linear when a whole-library scan passes every file as a scope", () => {
  const paths = Array.from({ length: 5000 }, (_, index) => trackPath(index));
  const seenPaths = new Set(paths);

  const started = process.hrtime.bigint();
  const missing = collectMissingIndexedPaths({
    indexedPaths: new Set(paths),
    scopes: paths,
    scopesAreDirectories: false,
    seenPaths,
    failedPaths: new Set(),
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.deepEqual(missing, []);
  assert.ok(
    elapsedMs < 500,
    `reconcile took ${Math.round(elapsedMs)}ms for ${paths.length} files, which means it is still comparing every pair`,
  );
});
