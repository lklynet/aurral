import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AUDIO = new Map([
  [".flac", "audio/flac"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
]);

function probe(file) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,bit_rate:format_tags", "-of", "json", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const format = JSON.parse(result.stdout || "{}").format || {};
  const tags = Object.fromEntries(Object.entries(format.tags || {}).map(([key, value]) => [key.toLowerCase(), value]));
  return { tags, duration: Math.round(Number(format.duration) || 0), bitRate: Math.round((Number(format.bit_rate) || 0) / 1000) };
}

function walk(dir, files = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (AUDIO.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

export const songId = (file) => createHash("sha1").update(file).digest("hex").slice(0, 22);

export function createMediaIndex(mediaRoot) {
  const cache = new Map();
  let songs = [];
  let scannedAt = 0;

  function scan() {
    const next = [];
    for (const file of walk(mediaRoot)) {
      const stat = fs.statSync(file);
      let cached = cache.get(file);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        const info = probe(file);
        if (!info) continue;
        const { tags } = info;
        cached = {
          mtimeMs: stat.mtimeMs,
          song: {
            id: songId(file),
            path: file,
            title: tags.title || path.basename(file, path.extname(file)),
            artist: tags.artist || "Unknown Artist",
            albumArtist: tags.album_artist || tags.artist || "Unknown Artist",
            album: tags.album || path.basename(path.dirname(file)),
            track: Number.parseInt(tags.track, 10) || 0,
            discNumber: Number.parseInt(tags.disc, 10) || 1,
            year: Number.parseInt(String(tags.date || ""), 10) || 0,
            genre: tags.genre || "",
            musicBrainzId: tags.musicbrainz_trackid || tags.musicbrainz_releasetrackid || "",
            duration: info.duration,
            bitRate: info.bitRate,
            size: stat.size,
            suffix: path.extname(file).slice(1).toLowerCase(),
            contentType: AUDIO.get(path.extname(file).toLowerCase()),
            created: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
          },
        };
        cache.set(file, cached);
      }
      next.push(cached.song);
    }
    songs = next.sort((left, right) => left.path.localeCompare(right.path));
    scannedAt = Date.now();
    return songs;
  }

  return {
    scan,
    songs(maxAgeMs = 3000) {
      return Date.now() - scannedAt > maxAgeMs ? scan() : songs;
    },
    get(id) {
      return this.songs().find((song) => song.id === id) || null;
    },
    search(query) {
      const terms = String(query || "").toLowerCase().replace(/["*]/g, "").split(/\s+/).filter(Boolean);
      return this.songs().filter((song) => {
        const haystack = `${song.title} ${song.artist} ${song.album}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    },
    get scannedAt() {
      return scannedAt;
    },
  };
}
