import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { buildAlbumHeaderMeta } from "../../frontend/src/pages/ArtistDetails/utils.ts";

const text = (segments: ReturnType<typeof buildAlbumHeaderMeta>) =>
  segments.map((segment) => segment.text).join(" · ");

test("the album header prefers MusicBrainz metadata and counts tracks properly", () => {
  const meta = buildAlbumHeaderMeta({
    release: {
      "first-release-date": "2001",
      "primary-type": "Album",
      "secondary-types": ["Live"],
      listenerCount: 1200,
    },
    libraryAlbum: null,
    trackCount: 1,
    durationMs: 3_725_000,
  });
  assert.equal(text(meta), "2001 · Album · Live · 1 track · 1 hr 2 min · 1.2K listeners");
});

test("a library album without MusicBrainz details still shows its own metadata", () => {
  const meta = buildAlbumHeaderMeta({
    release: null,
    libraryAlbum: {
      id: 3,
      releaseDate: "1999",
      metadata: { albumType: "ep" },
    } as never,
    trackCount: 0,
    durationMs: 0,
  });
  assert.equal(text(meta), "1999 · EP");
});

test("a partly owned album counts its available tracks like the library cards", () => {
  const meta = buildAlbumHeaderMeta({
    release: null,
    libraryAlbum: null,
    trackCount: 15,
    availableCount: 1,
    durationMs: 0,
  });
  assert.deepEqual(meta, [{ text: "1/15 tracks", partial: true }]);
  const complete = buildAlbumHeaderMeta({
    release: null,
    libraryAlbum: null,
    trackCount: 15,
    availableCount: 15,
    durationMs: 0,
  });
  assert.deepEqual(complete, [{ text: "15 tracks", partial: false }]);
});
