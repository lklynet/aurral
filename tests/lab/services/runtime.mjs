import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const LOSSY_CODECS = {
  ".m4a": ["-c:a", "aac", "-b:a", "256k"],
  ".mp3": ["-c:a", "libmp3lame", "-b:a", "320k"],
};

export function searchWords(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function includesAllWords(query, text) {
  const wanted = searchWords(text);
  return wanted.length > 0 && wanted.every((word) => query.has(word));
}

export function trackDurationSeconds(index) {
  return 30 + index;
}

export function catalogTracks(catalog) {
  return catalog.artists.flatMap((artist) =>
    artist.albums.flatMap((album) => album.tracks.map((title, index) => ({ artist, album, title, index }))));
}

export function similarArtists(catalog, artist) {
  const shared = (other) => other.genres.filter((genre) => artist.genres.includes(genre)).length;
  return catalog.artists
    .filter((other) => other !== artist)
    .map((other) => ({ artist: other, match: Math.min(1, 0.4 + shared(other) * 0.3) }))
    .sort((left, right) => right.match - left.match || left.artist.name.localeCompare(right.artist.name));
}

export function solidPng(seed, size = 64) {
  const [r, g, b] = createHash("sha1").update(String(seed)).digest();
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).fill(Buffer.from([r, g, b]))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function numericId(seed) {
  return (parseInt(createHash("sha1").update(String(seed)).digest("hex").slice(0, 8), 16) % 900_000_000) + 100_000_000;
}

export function createDownloads(initialMode = "complete", { queuedMs = 2000, downloadingMs = 3000 } = {}) {
  let mode = initialMode === "hold" ? "hold" : "complete";
  const items = new Set();

  return {
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next === "hold" ? "hold" : "complete";
      if (mode === "complete") {
        for (const item of items) item.releasedAt ??= Date.now();
      }
    },
    add(item) {
      item.releasedAt = mode === "complete" ? Date.now() : null;
      items.add(item);
      return item;
    },
    remove(item) {
      items.delete(item);
    },
    tick() {
      for (const item of items) {
        try {
          this.progress(item);
        } catch (error) {
          console.error("A simulated download failed to complete:", error);
        }
      }
    },
    progress(item) {
      if (item.completedAt) return { stage: "completed", fraction: 1 };
      if (item.releasedAt == null) return { stage: "queued", fraction: 0 };
      const elapsed = Date.now() - item.releasedAt;
      if (elapsed < queuedMs) return { stage: "queued", fraction: 0 };
      if (elapsed < queuedMs + downloadingMs) {
        return { stage: "downloading", fraction: (elapsed - queuedMs) / downloadingMs };
      }
      if (!item.completedAt) {
        item.complete?.();
        item.completedAt = Date.now();
      }
      return { stage: "completed", fraction: 1 };
    },
  };
}

export function createTrackFiles(cacheDir) {
  const cache = new Map();
  return {
    file(artist, album, index, extension = "flac") {
      const key = `${album.id}:${index}:${extension}`;
      if (!cache.has(key)) {
        const target = path.join(cacheDir, album.id, `${String(index + 1).padStart(2, "0")}.${extension}`);
        const size = writeTrack(target, {
          artist: artist.name,
          album: album.title,
          title: album.tracks[index],
          trackNumber: index + 1,
          durationSeconds: trackDurationSeconds(index),
          frequency: 330 + index * 55,
        });
        cache.set(key, { path: target, size });
      }
      return cache.get(key);
    },
  };
}

export function copyInto(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

export function writeTrack(target, { artist, album, title, trackNumber, durationSeconds, frequency = 440, sampleRate = 44100 }) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lossy = LOSSY_CODECS[path.extname(target).toLowerCase()];
  const source = lossy
    ? `anoisesrc=color=pink:amplitude=0.05:seed=${frequency}:duration=${durationSeconds}`
    : `sine=frequency=${frequency}:duration=${durationSeconds}`;
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", source,
      "-ac", lossy ? "2" : "1", "-ar", String(sampleRate),
      ...(lossy || []),
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

export function createCertificates(dir, hosts) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (name) => path.join(dir, name);
  const openssl = (args) => {
    const result = spawnSync("openssl", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.error?.message || result.stderr}`);
  };
  const ecKey = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl(["req", "-x509", ...ecKey, "-keyout", file("ca-key.pem"), "-out", file("ca.tmp.pem"), "-days", "30",
    "-subj", "/CN=Aurral Lab CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  openssl(["req", ...ecKey, "-keyout", file("server-key.pem"), "-out", file("server.csr"), "-subj", "/CN=Aurral Lab public services"]);
  fs.writeFileSync(file("server.ext"), [
    `subjectAltName=${["fixtures", ...hosts].map((host) => `DNS:${host}`).join(",")}`,
    "basicConstraints=CA:FALSE",
    "keyUsage=critical,digitalSignature",
    "extendedKeyUsage=serverAuth",
  ].join("\n"));
  openssl(["x509", "-req", "-in", file("server.csr"), "-CA", file("ca.tmp.pem"), "-CAkey", file("ca-key.pem"),
    "-set_serial", String(Date.now()), "-out", file("server.pem"), "-days", "30", "-extfile", file("server.ext")]);
  fs.renameSync(file("ca.tmp.pem"), file("ca.pem"));
  return { cert: fs.readFileSync(file("server.pem")), key: fs.readFileSync(file("server-key.pem")) };
}
