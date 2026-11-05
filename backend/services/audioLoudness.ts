import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import PQueue from "p-queue";
import { db } from "../config/db-sqlite.ts";
import type { AudioLoudnessRow } from "../db/rows.ts";

const MEASURE_TIMEOUT_MS = 60_000;

const getStmt = db.prepare<[string], AudioLoudnessRow>(
  "SELECT * FROM audio_loudness WHERE path = ?",
);
const saveStmt = db.prepare<[string, number, number, number, number]>(
  `INSERT INTO audio_loudness (path, size, mtime_ms, lufs, measured_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(path) DO UPDATE SET
     size = excluded.size,
     mtime_ms = excluded.mtime_ms,
     lufs = excluded.lufs,
     measured_at = excluded.measured_at`,
);

export async function measureLoudness(path: string) {
  const child = spawn(
    "ffmpeg",
    [
      "-nostats",
      "-hide_banner",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-af",
      "ebur128=framelog=quiet",
      "-f",
      "null",
      "-",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    log = (log + chunk).slice(-4096);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), MEASURE_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  const integrated = [...log.matchAll(/I:\s+(-?\d+(?:\.\d+)?) LUFS/g)].at(-1)?.[1];
  return code === 0 && integrated ? Number(integrated) : null;
}

const measurements = new PQueue({ concurrency: 2 });
const inflight = new Map<string, Promise<number | null>>();

async function measureAndStore(path: string) {
  const stat = await fs.stat(path).catch(() => null);
  if (!stat?.isFile()) return null;
  const mtimeMs = Math.trunc(stat.mtimeMs);
  const stored = getStmt.get(path);
  if (stored?.size === stat.size && stored.mtime_ms === mtimeMs) return stored.lufs;
  const lufs = await measurements.add(() => measureLoudness(path));
  if (lufs == null) return null;
  saveStmt.run(path, stat.size, mtimeMs, lufs, Date.now());
  return lufs;
}

export function fileLoudness(path: string) {
  const pending = inflight.get(path);
  if (pending) return pending;
  const next = measureAndStore(path).finally(() => inflight.delete(path));
  inflight.set(path, next);
  return next;
}
