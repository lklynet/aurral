import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFile } from "music-metadata";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [state, { db }, { downloadTracker }, { processYtdlpPipelinePayload }] = await setupIsolatedBackend(
  "ytdlp-song-search",
  "backend/config/db-sqlite.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/ytdlpOrchestrator.js",
);

const recorded = JSON.parse(await readFile(new URL("./ytdlp-song-search.fixtures.json", import.meta.url), "utf8"));
const binDir = path.join(state.baseDir, "bin");
const fixturePath = path.join(state.baseDir, "ytdlp-fixtures.json");
const logPath = path.join(state.baseDir, "ytdlp-calls.jsonl");
const pidPath = path.join(state.baseDir, "ytdlp-pids");
const previousPath = process.env.PATH;

// Answers the way yt-dlp does from recorded JSON: song lists, song reads,
// video searches, and downloads tagged as `--embed-metadata` tags them. A
// song's `delay` holds its read open, as a slow or stalled read does.
await mkdir(binDir, { recursive: true });
await writeFile(path.join(binDir, "yt-dlp"), [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "const { execFileSync } = require('node:child_process');",
  `const fixtures = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));`,
  "const args = process.argv.slice(2);",
  "const target = args.at(-1);",
  `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(target) + '\\n');`,
  `fs.appendFileSync(${JSON.stringify(pidPath)}, process.pid + '\\n');`,
  "const print = (entries) => process.stdout.write(entries.map((entry) => JSON.stringify(entry)).join('\\n'));",
  "if (target.startsWith('ytsearch')) {",
  "  print(fixtures.videos[target.slice(target.indexOf(':') + 1)] || []);",
  "  process.exit(0);",
  "}",
  "const url = new URL(target);",
  "if (url.pathname === '/search') {",
  "  const list = fixtures.songLists[url.searchParams.get('q')];",
  "  if (!list) { process.stderr.write('ERROR: Unable to download API page'); process.exit(1); }",
  "  print(list);",
  "  process.exit(0);",
  "}",
  "const id = url.searchParams.get('v');",
  "const song = fixtures.songs[id];",
  "if (!song) { process.stderr.write('ERROR: Sign in to confirm your age'); process.exit(1); }",
  "if (args.includes('--skip-download')) { setTimeout(() => print([song]), song.delay || 0); return; }",
  "const parse = args.includes('--parse-metadata') ? args[args.indexOf('--parse-metadata') + 1] : null;",
  "const pair = parse ? new RegExp(parse.slice(6).replace(/\\(\\?P</g, '(?<')).exec(song.track) : null;",
  "const artist = pair ? pair.groups.artist : song.artists.join(', ');",
  "const output = args[args.indexOf('-o') + 1].replace('%(id)s', id).replace('%(ext)s', 'm4a');",
  "execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', String(song.fileDuration || song.duration),",
  "  '-c:a', 'aac', '-b:a', '128k', '-metadata', `title=${song.track}`,",
  "  '-metadata', `artist=${artist}`, '-metadata', `album=${song.fileAlbum || song.album}`, output]);",
].join("\n"));
await chmod(path.join(binDir, "yt-dlp"), 0o755);
process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;

test.beforeEach(async () => {
  resetDatabase(db);
  await writeFile(fixturePath, JSON.stringify(recorded));
  await writeFile(logPath, "");
  await writeFile(pidPath, "");
});

test.after(async () => {
  process.env.PATH = previousPath;
  await cleanupIsolatedState(state);
});

async function useFixtures(change) {
  const fixtures = structuredClone(recorded);
  change(fixtures);
  await writeFile(fixturePath, JSON.stringify(fixtures));
}

// Songs are read in parallel, so their reads are listed in id order.
async function calls() {
  const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean).map((line) => {
    const target = JSON.parse(line);
    if (target.startsWith("ytsearch")) return `video search ${target.slice(target.indexOf(":") + 1)}`;
    const url = new URL(target);
    return url.pathname === "/search" ? `song search ${url.searchParams.get("q")}` : `read ${url.searchParams.get("v")}`;
  });
  const reads = lines.filter((line) => line.startsWith("read ")).sort();
  return lines.map((line) => line.startsWith("read ") ? reads.shift() : line);
}

const failSource = { failOrTryNextSource: (_payload, _job, reason) => ({ failed: reason }) };

async function search(track) {
  const jobId = downloadTracker.addJob(track, "ytdlp-song-search");
  return { jobId, next: await processYtdlpPipelinePayload({ phase: "search", source: "ytdlp", jobId }, failSource) };
}

const choices = (next) => next.candidates.map((entry) => [entry.raw.id, entry.evaluation.decision]);

function assertNoYtdlpLeft(pids) {
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `yt-dlp ${pid} is still running`);
}

async function ytdlpPids() {
  return (await readFile(pidPath, "utf8")).split("\n").filter(Boolean).map(Number);
}

for (const { name, track, unreadable = [], delays = {}, chosen } of [
  {
    name: "accepts the one song that names the requested artist, title, and length",
    track: { artistName: "Daft Punk", trackName: "Get Lucky", albumName: "Random Access Memories", durationMs: 369000 },
    chosen: [["4D7u5KF7SP8", "accept"]],
  },
  {
    name: "rejects a tribute act and a cover by their artists",
    track: { artistName: "Queen", trackName: "Bohemian Rhapsody", albumName: "A Night at the Opera", durationMs: 354000 },
    chosen: [["BSTsnWoslP4", "accept"]],
  },
  {
    name: "keeps a compilation copy of the same recording, read after the album's, to check after it",
    track: { artistName: "The Used", trackName: "Let It Bleed", albumName: "In Love and Death", durationMs: 190693 },
    delays: { "Fs3h2a-JxHA": 300 },
    chosen: [["tMgH40LmQds", "accept"], ["Fs3h2a-JxHA", "verify"]],
  },
  {
    name: "keeps the songs it could read when another cannot be read",
    track: { artistName: "Fleetwood Mac", trackName: "Dreams", albumName: "Rumours", durationMs: 257000 },
    unreadable: ["swJOIjjW69U"],
    chosen: [["5oWyMakvQew", "accept"], ["m8i5WiWCN-c", "verify"]],
  },
]) {
  test(`yt-dlp YouTube Music search ${name}`, async () => {
    await useFixtures((fixtures) => {
      unreadable.forEach((id) => delete fixtures.songs[id]);
      Object.entries(delays).forEach(([id, delay]) => Object.assign(fixtures.songs[id], { delay }));
    });
    const { next } = await search(track);
    assert.equal(next.phase, "download", next.failed);
    assert.deepEqual(choices(next), chosen);
    assert.deepEqual((await calls()).filter((call) => !call.startsWith("read ")),
      [`song search ${track.artistName} ${track.trackName}`]);
  });
}

test("yt-dlp keeps the songs a stalled read's batch holds at the search deadline and reads no more", { timeout: 20000 }, async () => {
  await useFixtures((fixtures) => { fixtures.songs["5oWyMakvQew"].delay = 600000; });
  const { next } = await search({ artistName: "Fleetwood Mac", trackName: "Dreams", albumName: "Rumours", durationMs: 257000 });
  assert.deepEqual(choices(next), [["swJOIjjW69U", "accept"], ["m8i5WiWCN-c", "verify"]]);
  assert.deepEqual(await calls(), [
    "song search Fleetwood Mac Dreams",
    "read 5oWyMakvQew",
    "read m8i5WiWCN-c",
    "read swJOIjjW69U",
  ]);
  assertNoYtdlpLeft(await ytdlpPids());
});

test("yt-dlp gives up on a stalled song read at the search deadline and searches videos", { timeout: 20000 }, async (t) => {
  await useFixtures((fixtures) => { fixtures.songs.BGMfbFzONp8.delay = 600000; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const searching = search({
    artistName: "宇多田ヒカル", artistAliases: ["Utada Hikaru", "Hikaru Utada"],
    trackName: "First Love", albumName: "First Love", durationMs: 257000,
  });
  while (!(await calls()).includes("read BGMfbFzONp8")) await new Promise((resolve) => setImmediate(resolve));
  const stalled = (await ytdlpPids()).at(-1);
  t.mock.timers.tick(10000);
  const { next } = await searching;
  assert.equal(next.candidates[0].raw.id, "o1sUaVJUeB0");
  assert.ok((await calls()).includes("video search 宇多田ヒカル First Love"));
  assertNoYtdlpLeft([stalled]);
});

async function useArtistUpload() {
  await useFixtures((fixtures) => {
    fixtures.songLists["Stub Artist Stub Title"] = [{ id: "OFFICIALAUD", title: "Stub Title" }];
    fixtures.songs.OFFICIALAUD = {
      track: "Stub Title", artists: ["Stub Artist"], album: "Other Album", duration: 206, channel: "Stub Artist",
    };
    fixtures.videos["Stub Artist Stub Title"] = [
      { id: "OFFICIALAUD", title: "Stub Artist - Stub Title", channel: "Stub Artist - Topic", duration: 206 },
      { id: "REUPLOAD001", title: "Stub Artist - Stub Title (Lyrics)", channel: "7clouds", duration: 196 },
    ];
  });
}

test("yt-dlp searches the artist's own upload when YouTube Music lists it on another album", async () => {
  await useArtistUpload();
  const { next } = await search({
    artistName: "Stub Artist", trackName: "Stub Title", albumName: "Requested Album", durationMs: 200000,
  });
  assert.equal(next.candidates[0].raw.id, "OFFICIALAUD");
  assert.equal(next.candidates[0].raw.song, undefined);
  assert.deepEqual(await calls(), [
    "song search Stub Artist Stub Title",
    "read OFFICIALAUD",
    "video search Stub Artist Stub Title",
  ]);
});

test("yt-dlp offers a song once when the video search finds it again", async () => {
  await useArtistUpload();
  const { next } = await search({
    artistName: "Stub Artist", trackName: "Stub Title", albumName: "Other Album", durationMs: 197000,
  });
  assert.deepEqual(choices(next), [["REUPLOAD001", "accept"], ["OFFICIALAUD", "review"]]);
});

test("yt-dlp reads the songs around an untitled entry in the YouTube Music list", async () => {
  await useFixtures((fixtures) => {
    fixtures.songLists["Fleetwood Mac Dreams"] = [
      { id: "UNTITLED001", title: "" },
      { id: "swJOIjjW69U", title: "Dreams (2004 Remaster)" },
      { id: "m8i5WiWCN-c", title: "Dreams" },
    ];
  });
  const { next } = await search({ artistName: "Fleetwood Mac", trackName: "Dreams", albumName: "Rumours", durationMs: 257000 });
  assert.deepEqual((await calls()).filter((call) => !call.startsWith("read ")), ["song search Fleetwood Mac Dreams"]);
  assert.deepEqual(choices(next)[0], ["swJOIjjW69U", "accept"]);
});

test("yt-dlp does not read a song the user denied", async () => {
  const track = { artistName: "The Used", trackName: "I Caught Fire", albumName: "In Love and Death", durationMs: 204760 };
  const jobId = downloadTracker.addJob(track, "ytdlp-song-search");
  downloadTracker.recordDeniedSource(jobId, "ytdlp", "FfaeB0jZAso");
  await processYtdlpPipelinePayload({ phase: "search", source: "ytdlp", jobId }, failSource);
  const log = await calls();
  assert.equal(log[0], "song search The Used I Caught Fire");
  assert.deepEqual(log.filter((call) => call.startsWith("read ")), []);
});

const help = {
  N4KvafPbauw: { track: "Help! (Remastered 2015)", album: "1", duration: 139 },
  MKUex3fci5c: { track: "Help! (Remastered 2009)", album: "Help!", duration: 140 },
  STEREOMIX01: { track: "Help! (2015 Stereo Mix)", album: "The Beatles 1962-1966", duration: 139 },
  HELPCOVER01: { track: "Help!", album: "Beatles Forever", duration: 141, artists: ["The Mersey Tribute"] },
  HELPCOVER02: { track: "Help!", album: "Help!", duration: 152, artists: ["Sound-Alike Studio"] },
};

async function useHelpSongs(ids, change = () => {}) {
  await useFixtures((fixtures) => {
    fixtures.songLists["The Beatles Help!"] = ids.map((id) => ({ id, title: help[id].track }));
    for (const id of ids) fixtures.songs[id] = { artists: ["The Beatles"], ...help[id] };
    change(fixtures);
  });
}

test("yt-dlp accepts only the requested album's copy of a song outright and rejects another mix", async () => {
  await useHelpSongs(["N4KvafPbauw", "STEREOMIX01", "MKUex3fci5c"]);
  const { next } = await search({ artistName: "The Beatles", trackName: "Help!", albumName: "Help!", durationMs: 138000 });
  assert.deepEqual(choices(next), [["MKUex3fci5c", "accept"], ["N4KvafPbauw", "verify"]]);
});

test("yt-dlp imports the requested album's song that YouTube Music labels mono", async () => {
  const satisfaction = "(I Can't Get No) Satisfaction";
  const songs = [
    ["eUpb-ALfUzc", `${satisfaction} (Mono)`, "Out Of Our Heads", "The Rolling Stones", 223],
    ["MSSxnv1_J2g", `${satisfaction} (Mono)`, "The Rolling Stones In Mono", "The Rolling Stones", 223],
    ["hLJju4s8HZU", "[I Can't Get No] Satisfaction", "40th Anniversary Special Live from the MGM Grand in Las Vegas",
      "The Four Tops", 161],
  ];
  await useFixtures((fixtures) => {
    fixtures.songLists[`The Rolling Stones ${satisfaction}`] = songs.map(([id, track]) => ({ id, title: track }));
    for (const [id, track, album, artist, duration] of songs) {
      fixtures.songs[id] = { track, artists: [artist], album, duration, channel: artist };
    }
  });
  const { jobId, next: download } = await search({
    artistName: "The Rolling Stones", trackName: satisfaction, albumName: "Out of Our Heads", durationMs: 222000,
  });
  assert.equal(download.phase, "download", download.failed);
  assert.deepEqual(choices(download), [["eUpb-ALfUzc", "accept"], ["MSSxnv1_J2g", "verify"]]);
  const finalize = await processYtdlpPipelinePayload({ ...download, destination: "ytdlp-song-search" }, failSource);
  await processYtdlpPipelinePayload(finalize, failSource);
  const job = downloadTracker.getJob(jobId);
  assert.equal(job.status, "done", job.error);
  assert.equal(job.releaseGuid, "eUpb-ALfUzc");
});

test("yt-dlp settles for an exact song on another album once the first three songs are read", async () => {
  await useHelpSongs(["N4KvafPbauw", "HELPCOVER01", "HELPCOVER02", "MKUex3fci5c"]);
  const { next } = await search({ artistName: "The Beatles", trackName: "Help!", albumName: "Help!", durationMs: 138000 });
  assert.deepEqual(await calls(), [
    "song search The Beatles Help!",
    "read HELPCOVER01",
    "read HELPCOVER02",
    "read N4KvafPbauw",
  ]);
  assert.deepEqual(choices(next), [["N4KvafPbauw", "verify"]]);
});

for (const { name, albumName = "1", fileAlbum, imported } of [
  { name: "imports a song file 5 seconds longer than the request on the requested album", imported: true },
  { name: "holds a song file 5 seconds longer than the request on another album", albumName: "Help!", imported: false },
  { name: "holds a song file 5 seconds longer than the request when its own tag names another album", fileAlbum: "Help!",
    imported: false },
]) {
  test(`yt-dlp ${name}`, async () => {
    await useHelpSongs(["N4KvafPbauw"], (fixtures) => {
      Object.assign(fixtures.songs.N4KvafPbauw, { fileDuration: 143, fileAlbum });
    });
    const { jobId, next: download } = await search({ artistName: "The Beatles", trackName: "Help!", albumName, durationMs: 138000 });
    assert.equal(download.phase, "download", download.failed);
    const finalize = await processYtdlpPipelinePayload({ ...download, destination: "ytdlp-song-search" }, failSource);
    assert.equal(finalize.phase, "finalize", finalize.failed);
    await processYtdlpPipelinePayload(finalize, failSource);
    assert.equal(downloadTracker.getJob(jobId).status === "done", imported);
  });
}

test("yt-dlp searches videos when no YouTube Music song is the requested recording", async () => {
  const { next } = await search({
    artistName: "宇多田ヒカル", artistAliases: ["Utada Hikaru", "Hikaru Utada"],
    trackName: "First Love", albumName: "First Love", durationMs: 257000,
  });
  assert.deepEqual(await calls(), [
    "song search 宇多田ヒカル First Love",
    "read BGMfbFzONp8",
    "read KvVk6FvnKj0",
    "read ceWbCc-3uKY",
    "read t21dyImwINM",
    "video search 宇多田ヒカル First Love",
  ]);
  assert.equal(next.candidates[0].raw.id, "o1sUaVJUeB0");
  assert.equal(next.candidates.some((entry) => entry.raw.song), false);
});

test("yt-dlp searches videos when the YouTube Music search fails", async () => {
  const { next } = await search({
    artistName: "Nirvana", trackName: "Come as You Are", albumName: "Nevermind", durationMs: 216000,
  });
  assert.deepEqual((await calls()).slice(0, 2), [
    "song search Nirvana Come as You Are",
    "video search Nirvana Come as You Are",
  ]);
  assert.equal(next.phase, "download", next.failed);
});

for (const track of [
  { artistName: "Black Sabbath", trackName: "Black Sabbath", albumName: "Black Sabbath", durationMs: 379893 },
  {
    artistName: "宇多田ヒカル", artistAliases: ["Hikaru Utada"], trackName: "First Love - From THE FIRST TAKE",
    albumName: "First Love - From THE FIRST TAKE", durationMs: 259000,
  },
]) {
  test(`yt-dlp imports the YouTube Music song "${track.trackName}" by its own tags`, async () => {
    const { jobId, next: download } = await search(track);
    assert.equal(download.phase, "download", download.failed);
    const finalize = await processYtdlpPipelinePayload({ ...download, destination: "ytdlp-song-search" }, failSource);
    assert.equal(finalize.phase, "finalize", finalize.failed);
    const result = await processYtdlpPipelinePayload(finalize, failSource);
    assert.equal(result?.failed, undefined);
    const job = downloadTracker.getJob(jobId);
    assert.equal(job.status, "done", job.error);
    assert.equal(job.releaseGuid, download.candidates[0].raw.id);
    await access(job.finalPath);
    const { common } = await parseFile(job.finalPath);
    assert.equal(common.title, track.trackName);
    await assert.rejects(access(path.dirname(finalize.downloadedPath)));
  });
}
