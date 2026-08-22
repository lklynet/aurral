import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("hosted Subsonic single and paged reads do not use the complete-library helper", async () => {
  const source = await read("../../backend/services/subsonicLibraryService.js");

  assert.doesNotMatch(source, /\bfunction readLibrary\b/);
  assert.doesNotMatch(source, /\bconst indexLibrary\b/);
  assert.doesNotMatch(source, /getCanonicalLibrary\(\{\s*availableOnly:\s*false/);
});

test("legacy canonical compatibility reads select focused adapters", async () => {
  const sources = await Promise.all([
    read("../../backend/routes/library/handlers/artists.js"),
    read("../../backend/routes/library/handlers/albums.js"),
    read("../../backend/routes/library/handlers/tracks.js"),
  ]);

  for (const source of sources) {
    assert.doesNotMatch(source, /getCanonicalLibraryReadModel\(/);
    assert.doesNotMatch(source, /\bgetCanonicalLibrary\(/);
  }
});
