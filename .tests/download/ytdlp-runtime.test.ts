import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const client = new YtdlpClient({ enabled: true });
    const directory = path.join(tempDir, "staging");
    await mkdir(directory);
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
        const filePath = await client.downloadAudio(
          `https://example.test/video?title=${encodeURIComponent(title)}`,
          { directory },
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
  "an aborted yt-dlp download stops yt-dlp and the processes it started",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-cancel-"));
    const binaryPath = path.join(tempDir, "yt-dlp");
    const pidPath = path.join(tempDir, "pids");
    const previousPath = process.env.PATH;
    const grandchildScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `fs.appendFileSync(${JSON.stringify(pidPath)}, process.pid + '\\n');`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(
      binaryPath,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "process.on('SIGTERM', () => {});",
        `fs.appendFileSync(${JSON.stringify(pidPath)}, process.pid + '\\n');`,
        `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
        "setInterval(() => {}, 100);",
      ].join("\n"),
    );
    await chmod(binaryPath, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath || ""}`;
    const readPids = async () =>
      (await readFile(pidPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
    const running = (pid: number) => {
      try {
        return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
          .trim()
          .startsWith("Z");
      } catch {
        return false;
      }
    };
    let pids: number[] = [];
    try {
      const stop = new AbortController();
      const directory = path.join(tempDir, "staging");
      await mkdir(directory);
      const download = new YtdlpClient({ enabled: true }).downloadAudio(
        "https://example.test/video",
        { directory, signal: stop.signal },
      );
      while ((pids = await readPids()).length < 2) await new Promise(setImmediate);
      stop.abort(new Error("cancelled"));
      await assert.rejects(download, /cancelled/);
      const giveUp = Date.now() + 5000;
      while (pids.some(running) && Date.now() < giveUp) await new Promise(setImmediate);
      assert.deepEqual(pids.filter(running), []);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      process.env.PATH = previousPath;
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
      const directory = path.join(tempDir, "ytdlp", "refused");
      await mkdir(directory, { recursive: true });
      const filePath = await new YtdlpClient({ enabled: true }).downloadAudio(
        "https://example.test/video",
        { directory },
      );
      assert.equal(await readFile(filePath, "utf8"), "audio");
    } finally {
      process.env.PATH = previousPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "yt-dlp rewrites a private copy of a read-only cookies file",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-cookies-"));
    const binaryPath = path.join(tempDir, "yt-dlp");
    const cookiesPath = path.join(tempDir, "cookies.txt");
    const seenPath = path.join(tempDir, "seen.json");
    const previousPath = process.env.PATH;
    await writeFile(cookiesPath, "# Netscape HTTP Cookie File\n");
    await chmod(cookiesPath, 0o444);
    await writeFile(
      binaryPath,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const cookies = args[args.indexOf('--cookies') + 1];",
        `fs.writeFileSync(${JSON.stringify(seenPath)}, JSON.stringify({ cookies, content: fs.readFileSync(cookies, 'utf8') }));`,
        "fs.writeFileSync(cookies, 'rewritten');",
        "fs.writeFileSync(args[args.indexOf('-o') + 1].replace('%(id)s', 'video').replace('%(ext)s', 'm4a'), 'audio');",
      ].join("\n"),
    );
    await chmod(binaryPath, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath || ""}`;
    try {
      const client = new YtdlpClient({ enabled: true, cookiesPath });
      await client.downloadAudio("https://example.test/video", { directory: tempDir });
      const seen = JSON.parse(await readFile(seenPath, "utf8"));
      assert.notEqual(seen.cookies, cookiesPath);
      assert.equal(seen.content, "# Netscape HTTP Cookie File\n");
      assert.equal(existsSync(seen.cookies), false);
      assert.equal(await readFile(cookiesPath, "utf8"), "# Netscape HTTP Cookie File\n");
    } finally {
      process.env.PATH = previousPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "yt-dlp test connection reads a real video and names YouTube's sign-in check",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-test-connection-"));
    const binaryPath = path.join(tempDir, "yt-dlp");
    const blockedPath = path.join(tempDir, "blocked");
    const cookiesPath = path.join(tempDir, "cookies.txt");
    const previousPath = process.env.PATH;
    await writeFile(cookiesPath, "# Netscape HTTP Cookie File\n");
    await writeFile(
      binaryPath,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        `if (fs.existsSync(${JSON.stringify(blockedPath)})) {`,
        "  process.stderr.write('ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.');",
        "  process.exit(1);",
        "}",
        "process.stdout.write(JSON.stringify({ id: 'jNQXAC9IVRw', _version: { version: '2026.10.26' } }) + '\\n');",
      ].join("\n"),
    );
    await chmod(binaryPath, 0o755);
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath || ""}`;
    try {
      assert.deepEqual(await new YtdlpClient({ enabled: true }).testConnection(), {
        configured: true,
        ok: true,
        version: "2026.10.26",
        message: "yt-dlp 2026.10.26",
      });
      await writeFile(blockedPath, "");
      for (const [config, message] of [
        [{ enabled: true }, /Set a cookies file/],
        [{ enabled: true, cookiesPath }, /export it again/],
      ] as const) {
        const result = await new YtdlpClient(config).testConnection();
        assert.equal(result.ok, false);
        assert.match(result.message, message);
      }
    } finally {
      process.env.PATH = previousPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);
