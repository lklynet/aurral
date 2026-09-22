import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateAudioFileIntegrity } from "../../backend/services/trackMatching/postDownloadValidator.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("audio integrity rejects a truncated FLAC whose header still reports full duration", { skip: hasFfmpeg ? false : "ffmpeg unavailable" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aurral-audio-integrity-"));
  const fullPath = path.join(directory, "full.flac");
  const partialPath = path.join(directory, "partial.flac");
  try {
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=30",
        "-c:a",
        "flac",
        fullPath,
      ],
      { stdio: "ignore" },
    );
    const complete = await validateAudioFileIntegrity(fullPath);
    assert.equal(complete.valid, true);
    await copyFile(fullPath, partialPath);
    const fullSize = (await stat(fullPath)).size;
    await truncate(partialPath, Math.floor(fullSize / 3));

    const result = await validateAudioFileIntegrity(partialPath);

    assert.equal(result.valid, false);
    assert.match(result.reason, /integrity|decode/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
