// ISRC identity for downloaded files.
//
// Some download sources tag files with the recording's ISRC while carrying
// no MusicBrainz recording ID. The catalogue maps such an ISRC to its
// recording, the same mapping playlist imports already trust, so a tagged
// file can pair with the release track holding that recording even when its
// title or length reads differently.
//
// Resolution only ever adds identity: an unknown ISRC, a failed lookup, or
// an ambiguous one leaves the file matching by title and length, exactly as
// before.

import { lookupIds } from "../providers/metadataProvider.ts";
import { logger } from "../logger.ts";
import { readRecordingMbid } from "./nativeMatcher.ts";

// An ISRC names a recording the way the catalogue lookup keys it, such as
// `isrc:GBAYE0601498`. Only a 12-character code counts.
export const isrcLookupKey = (isrc: string | null | undefined) => {
  const code = String(isrc ?? "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
  return code.length === 12 ? `isrc:${code}` : null;
};

// The recording a file's ISRC names, or null when the catalogue does not
// know it. A lookup failure keeps the current matching, never rejects.
export async function lookupIsrcRecording(isrc: string | null | undefined) {
  const key = isrcLookupKey(isrc);
  if (!key) return null;
  try {
    const found = await lookupIds([key]);
    return readRecordingMbid(found.get(key)?.trackMbid);
  } catch (error: unknown) {
    logger.info(
      "track-matching",
      "Downloaded files keep matching by title without ISRC recordings",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}

type IsrcListingFile = {
  isrc?: string | null;
  recordingMbid?: string | null;
  isrcRecordingMbid?: string | null;
};

type IsrcManifestTrack = {
  recordingMbid?: unknown;
  recordingMbidAliases?: unknown;
};

export type ResolvedIsrcFile<File extends IsrcListingFile> = File & {
  isrcRecordingMbid: string | null;
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function trackRecordingIds(track: IsrcManifestTrack) {
  return [track.recordingMbid, ...stringList(track.recordingMbidAliases)]
    .map(readRecordingMbid)
    .filter((id): id is string => id !== null);
}

async function resolveKeys(keys: string[]): Promise<Map<string, { trackMbid: string | null }>> {
  try {
    return await lookupIds(keys);
  } catch (error: unknown) {
    logger.info(
      "track-matching",
      "Downloaded files keep matching by title without ISRC recordings",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return new Map<string, { trackMbid: string | null }>();
  }
}

// Resolves every file's ISRC against the release, stamping the recording on
// each file whose ISRC names exactly one recording of the release that no
// other file names. A file that already carries a recording ID needs no
// lookup, and anything unresolved, off-release, or claimed twice keeps
// matching by title and length.
export async function resolveListingFileIsrcs<
  File extends IsrcListingFile,
  Track extends IsrcManifestTrack,
>(
  files: File[],
  manifest: { tracks?: Track[] | null } | null | undefined,
): Promise<ResolvedIsrcFile<File>[]> {
  const resolved = files.map((file) => ({ ...file, isrcRecordingMbid: null as string | null }));
  const releaseRecordings = new Set(
    (manifest?.tracks ?? []).flatMap((track) => trackRecordingIds(track)),
  );
  if (!releaseRecordings.size) return resolved;
  const pending = new Map<string, ResolvedIsrcFile<File>[]>();
  for (const file of resolved) {
    if (file.recordingMbid || file.isrcRecordingMbid) continue;
    const key = isrcLookupKey(file.isrc);
    if (!key) continue;
    const group = pending.get(key) ?? [];
    group.push(file);
    pending.set(key, group);
  }
  const keys = [...pending.keys()];
  if (!keys.length) return resolved;
  const found = await resolveKeys(keys);
  const byRecording = new Map<string, ResolvedIsrcFile<File>[]>();
  for (const [key, group] of pending) {
    const recording = readRecordingMbid(found.get(key)?.trackMbid);
    if (!recording || !releaseRecordings.has(recording)) continue;
    const claimed = byRecording.get(recording) ?? [];
    claimed.push(...group);
    byRecording.set(recording, claimed);
  }
  for (const [recording, group] of byRecording) {
    const [only] = group;
    if (group.length === 1 && only) only.isrcRecordingMbid = recording;
  }
  return resolved;
}
