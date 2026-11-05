import { spawn } from "node:child_process";
import { resolveLibraryTrackPath } from "./libraryReadModel.ts";

const RATE = 3000;
const FPS = 30;
const HOP = RATE / FPS;
const DECODE_TIMEOUT_MS = 60_000;
const CACHE_SIZE = 64;

export type TrackPulse = { fps: number; levels: string };

export async function measurePulse(pcm: AsyncIterable<Buffer>): Promise<TrackPulse | null> {
  const energy: number[] = [];
  let sum = 0;
  let count = 0;
  let carry: Buffer | null = null;
  for await (const chunk of pcm) {
    const bytes: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
    const even = bytes.length - (bytes.length % 2);
    for (let i = 0; i < even; i += 2) {
      const sample = bytes.readInt16LE(i) / 32768;
      sum += sample * sample;
      count += 1;
      if (count < HOP) continue;
      energy.push(Math.sqrt(sum / HOP));
      sum = 0;
      count = 0;
    }
    carry = even < bytes.length ? bytes.subarray(even) : null;
  }
  const loud = energy.toSorted((a, b) => a - b)[Math.floor((energy.length - 1) * 0.95)];
  if (!loud) return null;
  const levels = Uint8Array.from(energy, (value) => Math.round(Math.min(1, value / loud) * 255));
  return { fps: FPS, levels: Buffer.from(levels).toString("base64") };
}

export async function filePulse(path: string) {
  const child = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-af",
      "lowpass=f=150",
      "-ar",
      String(RATE),
      "-f",
      "s16le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), DECODE_TIMEOUT_MS);
  try {
    const pulse = await measurePulse(child.stdout);
    return (await exited) === 0 ? pulse : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map<string, Promise<TrackPulse | null>>();

export function trackPulse(albumId: string, trackId: string) {
  const key = `${albumId}:${trackId}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const path = resolveLibraryTrackPath(albumId, trackId);
  if (!path) return Promise.resolve(null);
  const pending = filePulse(path);
  cache.set(key, pending);
  void pending.then((pulse) => {
    if (!pulse) cache.delete(key);
  });
  const oldest = cache.keys().next();
  if (cache.size > CACHE_SIZE && !oldest.done) cache.delete(oldest.value);
  return pending;
}
