import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  isrcLookupKey,
  lookupIsrcRecording,
  resolveListingFileIsrcs,
} from "../../backend/services/trackMatching/isrcRecording.ts";
import { lookupIds } from "../../backend/services/providers/metadataProvider.ts";

vi.mock("../../backend/services/providers/metadataProvider.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../backend/services/providers/metadataProvider.ts")
  >()),
  lookupIds: vi.fn(),
}));

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "33333333-3333-4333-8333-333333333333";

const answer = (entries: [string, string | null][]) =>
  new Map(
    entries.map(([isrc, trackMbid]) => [
      `isrc:${isrc}`,
      { trackMbid, albumMbid: null, artistMbid: null },
    ]),
  );

const manifest = (recordings: (string | null)[]) => ({
  tracks: recordings.map((recordingMbid) => ({ recordingMbid, recordingMbidAliases: [] })),
});

const file = (isrc: string | null, recordingMbid: string | null = null) => ({
  isrc,
  recordingMbid,
  isrcRecordingMbid: null as string | null,
});

test("isrcLookupKey keeps the catalogue key rule", () => {
  assert.equal(isrcLookupKey("gb-aye-06-01498"), "isrc:GBAYE0601498");
  assert.equal(isrcLookupKey("XXABC2600001"), "isrc:XXABC2600001");
  assert.equal(isrcLookupKey("short"), null);
  assert.equal(isrcLookupKey(null), null);
  assert.equal(isrcLookupKey(""), null);
});

test("lookupIsrcRecording maps a known ISRC to its recording and nothing else", async () => {
  vi.mocked(lookupIds).mockReset();
  vi.mocked(lookupIds).mockResolvedValue(answer([["XXABC2600001", FIRST]]));
  assert.equal(await lookupIsrcRecording("xxabc2600001"), FIRST);
  assert.equal(await lookupIsrcRecording("XXABC2699999"), null);
  assert.deepEqual(vi.mocked(lookupIds).mock.calls, [
    [["isrc:XXABC2600001"]],
    [["isrc:XXABC2699999"]],
  ]);
});

test("lookupIsrcRecording keeps the current matching when the catalogue fails", async () => {
  vi.mocked(lookupIds).mockReset();
  vi.mocked(lookupIds).mockRejectedValue(new Error("offline"));
  assert.equal(await lookupIsrcRecording("XXABC2600001"), null);
  assert.equal(await lookupIsrcRecording("short"), null);
});

test("resolveListingFileIsrcs stamps files whose ISRC names their own release track", async () => {
  vi.mocked(lookupIds).mockReset();
  vi.mocked(lookupIds).mockResolvedValue(
    answer([
      ["XXABC2600001", FIRST],
      ["XXABC2600002", SECOND],
    ]),
  );
  const files = [file("XXABC2600001"), file("XXABC2600002")];
  const resolved = await resolveListingFileIsrcs(files, manifest([FIRST, SECOND]));
  assert.deepEqual(
    resolved.map((entry) => entry.isrcRecordingMbid),
    [FIRST, SECOND],
  );
  assert.deepEqual(
    files.map((entry) => entry.isrcRecordingMbid),
    [null, null],
  );
  assert.deepEqual(vi.mocked(lookupIds).mock.calls, [[["isrc:XXABC2600001", "isrc:XXABC2600002"]]]);
});

test("resolveListingFileIsrcs leaves files without identity, off the release, or claimed twice", async () => {
  vi.mocked(lookupIds).mockReset();
  vi.mocked(lookupIds).mockResolvedValue(
    answer([
      ["XXABC2600001", FIRST],
      ["XXABC2600002", SECOND],
      ["XXABC2600003", FOREIGN],
    ]),
  );
  const files = [
    file(null),
    file("XXABC2600001", FIRST),
    file("XXABC2699999"),
    file("XXABC2600003"),
    file("XXABC2600001"),
    file("XXABC2600002"),
    file("XXABC2600002"),
  ];
  const resolved = await resolveListingFileIsrcs(files, manifest([FIRST, SECOND]));
  assert.deepEqual(
    resolved.map((entry) => entry.isrcRecordingMbid),
    [null, null, null, null, FIRST, null, null],
  );
  assert.deepEqual(vi.mocked(lookupIds).mock.calls, [
    [["isrc:XXABC2699999", "isrc:XXABC2600003", "isrc:XXABC2600001", "isrc:XXABC2600002"]],
  ]);
});

test("resolveListingFileIsrcs keeps the current matching when the catalogue fails or has no recordings", async () => {
  vi.mocked(lookupIds).mockReset();
  vi.mocked(lookupIds).mockRejectedValue(new Error("offline"));
  const files = [file("XXABC2600001")];
  const failed = await resolveListingFileIsrcs(files, manifest([FIRST]));
  assert.deepEqual(
    failed.map((entry) => entry.isrcRecordingMbid),
    [null],
  );
  vi.mocked(lookupIds).mockReset();
  const unrecorded = await resolveListingFileIsrcs(files, manifest([null]));
  assert.deepEqual(
    unrecorded.map((entry) => entry.isrcRecordingMbid),
    [null],
  );
  assert.equal(vi.mocked(lookupIds).mock.calls.length, 0);
});
