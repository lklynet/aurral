import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAurralDataDir } from "../config/data-dir.ts";

const CACHE_DIR = path.join(resolveAurralDataDir(), "flac-cache");
const MAX_CACHE_BYTES = 1024 ** 3;
const pending = new Map<string, Promise<string>>();
const partials = new Set<string>();

async function convert(source: string, target: string) {
  const partial = `${target}.part`;
  partials.add(partial);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const child = spawn(
    "ffmpeg",
    [
      ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source],
      ...["-map", "0:a:0", "-vn", "-c:a", "flac", "-f", "flac", partial],
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) throw new Error(`ffmpeg exited with ${code} converting ${source}`);
    await fs.rename(partial, target);
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  } finally {
    partials.delete(partial);
  }
}

async function prune(keep: string, maxBytes: number) {
  const names = await fs.readdir(CACHE_DIR);
  const files = (
    await Promise.all(
      names.map(async (name) => {
        const file = path.join(CACHE_DIR, name);
        const stat = await fs.stat(file).catch(() => null);
        return stat ? [{ file, size: stat.size, usedAt: stat.atimeMs }] : [];
      }),
    )
  ).flat();
  let total = files.reduce((sum, entry) => sum + entry.size, 0);
  const evictable = files
    .filter((entry) => entry.file !== keep && !partials.has(entry.file))
    .sort((left, right) => left.usedAt - right.usedAt);
  for (const entry of evictable) {
    if (total <= maxBytes) break;
    await fs.rm(entry.file, { force: true });
    total -= entry.size;
  }
}

async function cachedCopy(source: string, maxBytes: number) {
  const stat = await fs.stat(source);
  const key = createHash("sha256").update(`${source}\0${stat.size}\0${stat.mtimeMs}`).digest("hex");
  const target = path.join(CACHE_DIR, `${key}.flac`);
  try {
    const cached = await fs.stat(target);
    await fs.utimes(target, new Date(), cached.mtime);
    return target;
  } catch {}
  await convert(source, target);
  await prune(target, maxBytes).catch(() => {});
  return target;
}

export function flacCopy(source: string, maxBytes = MAX_CACHE_BYTES) {
  const existing = pending.get(source);
  if (existing) return existing;
  const next = cachedCopy(source, maxBytes).finally(() => pending.delete(source));
  pending.set(source, next);
  return next;
}
