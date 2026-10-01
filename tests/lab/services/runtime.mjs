import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function writeTrack(target, { artist, album, title, trackNumber, durationSeconds, frequency = 440 }) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${durationSeconds}`,
      "-ac", "1", "-ar", "8000",
      "-metadata", `artist=${artist}`,
      "-metadata", `album_artist=${artist}`,
      "-metadata", `album=${album}`,
      "-metadata", `title=${title}`,
      "-metadata", `track=${trackNumber}`,
      target,
    ],
    { encoding: "utf8" },
  );
  if (encoded.status !== 0) throw new Error(`ffmpeg could not write ${target}: ${encoded.error?.message || encoded.stderr}`);
  return fs.statSync(target).size;
}
