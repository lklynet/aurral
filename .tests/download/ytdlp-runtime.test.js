import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildYtdlpInvocationArgs, YtdlpClient } from "../../backend/services/ytdlpClient.js";

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

test("yt-dlp cancellation waits for a stubborn child to exit before clearing staging", {
  skip: process.platform === "win32",
}, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-cancel-"));
  const binaryPath = path.join(tempDir, "yt-dlp");
  const pidPath = path.join(tempDir, "child.pid");
  const grandchildPidPath = path.join(tempDir, "grandchild.pid");
  const grandchildMarkerPath = path.join(tempDir, "grandchild.marker");
  const previousPath = process.env.PATH;
  const previousPidPath = process.env.AURRAL_YTDLP_TEST_PID;
  const previousGrandchildPidPath = process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID;
  const previousMarkerPath = process.env.AURRAL_YTDLP_TEST_MARKER;
  const grandchildScript = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    "fs.writeFileSync(process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID, String(process.pid));",
    "setInterval(() => fs.writeFileSync(process.env.AURRAL_YTDLP_TEST_MARKER, String(Date.now())), 20);",
  ].join("\n");
  await writeFile(binaryPath, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "process.on('SIGTERM', () => {});",
    "fs.writeFileSync(process.env.AURRAL_YTDLP_TEST_PID, String(process.pid));",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore', env: process.env });`,
    "setInterval(() => {}, 100);",
  ].join("\n"));
  await chmod(binaryPath, 0o755);
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath || ""}`;
  process.env.AURRAL_YTDLP_TEST_PID = pidPath;
  process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID = grandchildPidPath;
  process.env.AURRAL_YTDLP_TEST_MARKER = grandchildMarkerPath;

  let pid;
  let grandchildPid;
  let childExited = false;
  let grandchildStopped = false;
  try {
    const client = new YtdlpClient({ enabled: true, stagingPath: tempDir });
    const download = client.downloadAudio("https://example.test/video", {
        jobId: "stubborn-child",
        shouldCancel: () => existsSync(pidPath) && existsSync(grandchildPidPath),
    });
    const cancelled = assert.rejects(download, { code: "DOWNLOAD_CANCELLED" });
    for (let attempt = 0; attempt < 50 && !existsSync(pidPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(pidPath), true);
    let cleanupFinished = false;
    const cleanup = client.cleanupStaging("stubborn-child").then(() => {
      cleanupFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(cleanupFinished, false);
    await cancelled;
    await cleanup;
    pid = Number(await readFile(pidPath, "utf8"));
    grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    childExited = true;
    const markerBefore = await readFile(grandchildMarkerPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await readFile(grandchildMarkerPath, "utf8"), markerBefore);
    grandchildStopped = true;
    assert.equal(existsSync(path.join(tempDir, "ytdlp", "stubborn-child")), false);
  } finally {
    if (!pid && existsSync(pidPath)) pid = Number(await readFile(pidPath, "utf8"));
    if (!grandchildPid && existsSync(grandchildPidPath)) {
      grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
    }
    if (!childExited && pid && Number.isInteger(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    if (!grandchildStopped && grandchildPid && Number.isInteger(grandchildPid)) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch {}
    }
    process.env.PATH = previousPath;
    if (previousPidPath === undefined) delete process.env.AURRAL_YTDLP_TEST_PID;
    else process.env.AURRAL_YTDLP_TEST_PID = previousPidPath;
    if (previousGrandchildPidPath === undefined) delete process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID;
    else process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID = previousGrandchildPidPath;
    if (previousMarkerPath === undefined) delete process.env.AURRAL_YTDLP_TEST_MARKER;
    else process.env.AURRAL_YTDLP_TEST_MARKER = previousMarkerPath;
    await rm(tempDir, { recursive: true, force: true });
  }
});
