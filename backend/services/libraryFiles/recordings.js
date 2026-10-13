import { parseFile } from "music-metadata";

export const SAME_LENGTH_MS = 3000;

export async function readRecording(filePath, metadata = null) {
  try {
    const parsed = metadata || await parseFile(filePath, { skipCovers: true, duration: false });
    let seconds = Number(parsed.format?.duration);
    if (!(seconds > 0)) seconds = Number((await parseFile(filePath, { skipCovers: true, duration: true })).format?.duration);
    return {
      durationMs: seconds > 0 ? Math.round(seconds * 1000) : null,
      lossless: parsed.format?.lossless === true,
      bitrate: Number(parsed.format?.bitrate) || 0,
      trackNumber: Number(parsed.common?.track?.no) || null,
    };
  } catch {
    return { durationMs: null, lossless: false, bitrate: 0, trackNumber: null };
  }
}

// MusicBrainz can give one recording to several tracks of a release, such as
// a run of silent tracks. Files whose tags number them differently are
// different tracks, not copies, whatever the Library merged them into.
export const differentTracks = (left, right) =>
  left.trackNumber > 0 && right.trackNumber > 0 && left.trackNumber !== right.trackNumber;

export const formatGap = (ms) => {
  const seconds = Math.round(Math.abs(ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

// Above zero when the left copy is better: lossless first, then bitrate.
export const compareQuality = (left, right) =>
  Number(left.lossless) - Number(right.lossless) || left.bitrate - right.bitrate;
