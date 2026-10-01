import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const QUEUED_MS = 2000;
const DOWNLOADING_MS = 3000;

export function trackDurationSeconds(index) {
  return 30 + index;
}

export function createDownloads(initialMode = "complete") {
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
    progress(item) {
      if (item.completedAt) return { stage: "completed", fraction: 1 };
      if (item.releasedAt == null) return { stage: "queued", fraction: 0 };
      const elapsed = Date.now() - item.releasedAt;
      if (elapsed < QUEUED_MS) return { stage: "queued", fraction: 0 };
      if (elapsed < QUEUED_MS + DOWNLOADING_MS) {
        return { stage: "downloading", fraction: (elapsed - QUEUED_MS) / DOWNLOADING_MS };
      }
      if (!item.completedAt) {
        item.complete?.();
        item.completedAt = Date.now();
      }
      return { stage: "completed", fraction: 1 };
    },
  };
}

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
