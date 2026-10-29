import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsPromises, { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildYtdlpInvocationArgs, YtdlpClient } from "../../backend/services/ytdlpClient.ts";
import { validateDownloadedTrackFile } from "../../backend/services/trackMatching/index.ts";

test(
  "yt-dlp stages source metadata that validates before canonical tags are written",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-validation-"));
    const binaryPath = path.join(tempDir, "yt-dlp");
    const audioPath = path.join(tempDir, "noise.m4a");
    const previousPath = process.env.PATH;
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=r=44100",
      "-t",
      "4",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      audioPath,
    ]);
    await writeFile(
      binaryPath,
      [
        `#!${process.execPath}`,
        "const { execFileSync } = require('node:child_process');",
        "const args = process.argv.slice(2);",
        "const title = new URL(args.at(-1)).searchParams.get('title');",
        "const output = args[args.indexOf('-o') + 1].replace('%(id)s', 'abc123DEF45').replace('%(ext)s', 'm4a');",
        "const tags = [];",
        "if (args.includes('--embed-metadata')) {",
        "  const parse = args[args.indexOf('--parse-metadata') + 1];",
        "  const pattern = parse && parse.startsWith('title:') ? parse.slice(6).replace(/\\(\\?P</g, '(?<') : null;",
        "  const pair = pattern ? new RegExp(pattern).exec(title) : null;",
        "  tags.push('-metadata', `title=${pair?.groups?.title || title}`, '-metadata', `artist=${pair?.groups?.artist || 'Music Channel'}`);",
        "}",
        `execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', ${JSON.stringify(audioPath)}, '-c', 'copy', ...tags, output]);`,
      ].join("\n"),
    );
    await chmod(binaryPath, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath || ""}`;
    const client = new YtdlpClient({ enabled: true, stagingPath: tempDir });
    try {
      for (const [title, valid, trackName = "Stitches", artistName = "Shawn Mendes"] of [
        ["Shawn Mendes - Stitches (Audio)", true],
        ["Shawn Mendes - Stitches (Lyrics)", true],
        ["Shawn Mendes - Stitches (Official Music Video)", true],
        ["Shawn Mendes - (Music)", true, "(Music)"],
        ["Shawn Mendes - Stitches - Radio Edit", true, "Stitches - Radio Edit"],
        ["Shawn Mendes – Life of the Party (Audio)", true, "Life of the Party"],
        ["宇多田ヒカル - 光 (Audio)", true, "光", "宇多田ヒカル"],
        ["Shawn Mendes - Stitches (Karaoke Version)", false],
        ["Shawn Mendes - Life of the Party (Audio)", false],
        ["Another Artist - Stitches (Audio)", false],
      ] as const) {
        const { filePath } = await client.downloadAudio(
          `https://example.test/video?title=${encodeURIComponent(title)}`,
          { jobId: "source-metadata" },
        );
        const validation = await validateDownloadedTrackFile({
          request: { artistName, trackName, durationMs: 4000 },
          candidate: { provider: { id: "abc123DEF45" } },
          filePath,
          source: "ytdlp",
        });
        assert.equal(validation.valid, valid, `${title}: ${validation.reason}`);
        assert.ok(validation.parsedTags != null);
        assert.equal(validation.parsedTags.title, title.replace(/^.+?\s+[-–—]\s+/, ""));
        await client.cleanupStaging("source-metadata");
        assert.equal(existsSync(filePath), false);
      }
    } finally {
      process.env.PATH = previousPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

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
  assert.deepEqual(buildYtdlpInvocationArgs(["--version"], { nodeAvailable: false }), [
    "--version",
  ]);
});

test(
  "yt-dlp cancellation waits for a stubborn child to exit before clearing staging",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-cancel-"));
    const binaryPath = path.join(tempDir, "yt-dlp");
    const pidPath = path.join(tempDir, "child.pid");
    const grandchildPidPath = path.join(tempDir, "grandchild.pid");
    const previousPath = process.env.PATH;
    const previousPidPath = process.env.AURRAL_YTDLP_TEST_PID;
    const previousGrandchildPidPath = process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID;
    const grandchildScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "fs.writeFileSync(process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID, String(process.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(
      binaryPath,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.AURRAL_YTDLP_TEST_PID, String(process.pid));",
        `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore', env: process.env });`,
        "setInterval(() => {}, 100);",
      ].join("\n"),
    );
    await chmod(binaryPath, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath || ""}`;
    process.env.AURRAL_YTDLP_TEST_PID = pidPath;
    process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID = grandchildPidPath;

    let pid: number | undefined;
    let grandchildPid: number | undefined;
    let childExited = false;
    let grandchildStopped = false;
    const until = async (condition: () => boolean) => {
      while (!condition()) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const running = (target: number) => {
      try {
        return !execFileSync("ps", ["-o", "stat=", "-p", String(target)], { encoding: "utf8" })
          .trim()
          .startsWith("Z");
      } catch {
        return false;
      }
    };
    const stagingDir = path.join(tempDir, "ytdlp", "stubborn-child");
    const removals: { target: import("node:fs").PathLike; childRunning: boolean }[] = [];
    const removeFiles = fsPromises.rm;
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const client = new YtdlpClient({ enabled: true, stagingPath: tempDir });
      const download = client.downloadAudio("https://example.test/video", {
        jobId: "stubborn-child",
        shouldCancel: () => existsSync(pidPath) && existsSync(grandchildPidPath),
      });
      const cancelled = assert.rejects(download, { code: "DOWNLOAD_CANCELLED" });
      await until(() => existsSync(pidPath) && existsSync(grandchildPidPath));
      pid = Number(await readFile(pidPath, "utf8"));
      grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
      vi.spyOn(fsPromises, "rm").mockImplementation((target, options) => {
        removals.push({ target, childRunning: running(pid!) });
        return removeFiles(target, options);
      });
      const cleanup = client.cleanupStaging("stubborn-child");
      await vi.advanceTimersByTimeAsync(1250);
      await cancelled;
      await cleanup;
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      childExited = true;
      const stagingRemovals = removals.filter((removal) => removal.target === stagingDir);
      assert.ok(stagingRemovals.length > 0);
      assert.ok(
        stagingRemovals.every((removal) => !removal.childRunning),
        "staging was cleared while yt-dlp was still running",
      );
      const giveUp = Date.now() + 5000;
      await until(() => !running(grandchildPid!) || Date.now() > giveUp);
      assert.equal(
        running(grandchildPid!),
        false,
        `yt-dlp grandchild ${grandchildPid} kept running`,
      );
      grandchildStopped = true;
      assert.equal(existsSync(stagingDir), false);
    } finally {
      if (!pid && existsSync(pidPath)) pid = Number(await readFile(pidPath, "utf8"));
      if (!grandchildPid && existsSync(grandchildPidPath)) {
        grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
      }
      if (!childExited && pid && Number.isInteger(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      if (!grandchildStopped && grandchildPid && Number.isInteger(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {}
      }
      process.env.PATH = previousPath;
      if (previousPidPath === undefined) delete process.env.AURRAL_YTDLP_TEST_PID;
      else process.env.AURRAL_YTDLP_TEST_PID = previousPidPath;
      if (previousGrandchildPidPath === undefined)
        delete process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID;
      else process.env.AURRAL_YTDLP_TEST_GRANDCHILD_PID = previousGrandchildPidPath;
      vi.restoreAllMocks();
      vi.useRealTimers();
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "a yt-dlp download refused with HTTP 403 runs once more with fresh media URLs",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-403-"));
    const binaryPath = path.join(tempDir, "yt-dlp");
    const previousPath = process.env.PATH;
    await writeFile(
      binaryPath,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "const output = args[args.indexOf('-o') + 1].replace('%(id)s', 'video').replace('%(ext)s', 'm4a');",
        "const marker = path.join(path.dirname(output), '..', '..', 'refused-once');",
        "if (!fs.existsSync(marker)) {",
        "  fs.writeFileSync(marker, '');",
        "  process.stderr.write('ERROR: unable to download video data: HTTP Error 403: Forbidden');",
        "  process.exit(1);",
        "}",
        "fs.writeFileSync(output, 'audio');",
      ].join("\n"),
    );
    await chmod(binaryPath, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath || ""}`;
    try {
      const client = new YtdlpClient({ enabled: true, stagingPath: tempDir });
      const { filePath } = await client.downloadAudio("https://example.test/video", {
        jobId: "refused",
      });
      assert.equal(await readFile(filePath, "utf8"), "audio");
      await client.cleanupStaging("refused");
    } finally {
      process.env.PATH = previousPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);
