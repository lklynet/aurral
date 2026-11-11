import { copyFileSync } from "node:fs";
import path from "node:path";
import { WORLD_RELEASES, readWorldManifest } from "../library/generate.ts";
import { searchKey } from "../metadata/search.ts";

// Stands in for the yt-dlp program. Aurral under Eden finds this one first on its
// PATH, so its built-in download source searches and downloads Eden's generated
// releases and never reaches YouTube. It answers the few ways Aurral calls yt-dlp.

const ROOT = process.env.EDEN_WORLD ?? "";
const args = process.argv.slice(2);
const target = args.at(-1) ?? "";

if (args.includes("--version")) {
  console.log("2026.01.01");
  process.exit(0);
}

const songs = readWorldManifest(ROOT).flatMap((release, releaseIndex) =>
  release.files.map((file, fileIndex) => ({
    id: `eden${String(releaseIndex).padStart(4, "0")}${String(fileIndex).padStart(3, "0")}`,
    release,
    file,
    key: searchKey(`${release.artist} ${file.title} ${release.album}`),
  })),
);

const describe = (song: (typeof songs)[number]) => ({
  id: song.id,
  title: song.file.title,
  track: song.file.title,
  artist: song.release.artist,
  artists: [song.release.artist],
  album: song.release.album,
  channel: song.release.artist,
  uploader: song.release.artist,
  duration: Math.round(song.file.durationMs / 1000),
  live_status: "not_live",
  webpage_url: `https://music.youtube.com/watch?v=${song.id}`,
});

function search(query: string, limit: number) {
  const words = searchKey(query).split(" ").filter(Boolean);
  return songs.filter((song) => words.every((word) => song.key.includes(word))).slice(0, limit);
}

const watched = URL.parse(target)?.searchParams.get("v");
const found = songs.find((song) => song.id === watched);
const output = args[args.indexOf("-o") + 1];

if (args.includes("--flat-playlist")) {
  const [, count, plain] = /^ytsearch(\d+):(.*)$/s.exec(target) ?? [];
  const query = plain ?? new URL(target).searchParams.get("q") ?? "";
  const limit = Number(count ?? args[args.indexOf("--playlist-end") + 1]) || 10;
  for (const song of search(query, limit)) console.log(JSON.stringify(describe(song)));
} else if (args.includes("--dump-json")) {
  // Aurral tests yt-dlp with a fixed video that Eden has no song for.
  console.log(JSON.stringify(found ? describe(found) : { id: "eden", title: "Eden" }));
} else if (found && args.includes("-o") && output) {
  copyFileSync(
    path.join(ROOT, WORLD_RELEASES, found.release.name, found.file.name),
    output.replace("%(id)s", found.id).replace("%(ext)s", "flac"),
  );
} else {
  console.error(`ERROR: Eden's yt-dlp has nothing for ${target}`);
  process.exit(1);
}
