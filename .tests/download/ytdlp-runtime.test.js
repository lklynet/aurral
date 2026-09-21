import { test } from "node:test";
import assert from "node:assert/strict";
import { buildYtdlpInvocationArgs } from "../../backend/services/ytdlpClient.js";

test("yt-dlp invocations use Node for YouTube JavaScript challenges when available", () => {
  assert.deepEqual(
    buildYtdlpInvocationArgs(["--no-playlist", "https://www.youtube.com/watch?v=test"], {
      nodeAvailable: true,
    }),
    [
      "--no-js-runtimes",
      "--js-runtimes",
      "node",
      "--no-playlist",
      "https://www.youtube.com/watch?v=test",
    ],
  );
});

test("yt-dlp invocations remain compatible without a local Node runtime", () => {
  assert.deepEqual(
    buildYtdlpInvocationArgs(["--version"], { nodeAvailable: false }),
    ["--version"],
  );
});
