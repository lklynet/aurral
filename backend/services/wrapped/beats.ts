import { spawn } from "node:child_process";
import { getDeezerPreviewLink } from "../apiClients/deezer.ts";
import { resolveLibraryTrackPath } from "../libraryReadModel.ts";

const RATE = 22050;
const FRAME = 1024;
const HOP = 256;
const FPS = RATE / HOP;
const SECONDS = 30;

export type WrappedBeats = { start: number; bpm: number; beats: number[]; downbeat: number };

const COS = Float64Array.from({ length: FRAME / 2 }, (_, k) =>
  Math.cos((-2 * Math.PI * k) / FRAME),
);
const SIN = Float64Array.from({ length: FRAME / 2 }, (_, k) =>
  Math.sin((-2 * Math.PI * k) / FRAME),
);

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const stride = n / length;
    for (let i = 0; i < n; i += length)
      for (let k = 0; k < length / 2; k++) {
        const wr = COS[k * stride];
        const wi = SIN[k * stride];
        const a = i + k;
        const b = a + length / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
  }
}

function average(values: Float32Array, span: number) {
  const result = new Float32Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= span) sum -= values[i - span];
    result[i] = sum / Math.min(i + 1, span);
  }
  return result;
}

export function findBeats(samples: Float32Array) {
  const frames = Math.floor((samples.length - FRAME) / HOP);
  if (frames < FPS * 8) return null;
  const window = Float64Array.from(
    { length: FRAME },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME),
  );
  const bins = FRAME / 2;
  const low = Math.round((150 * FRAME) / RATE);
  const flux = new Float32Array(frames);
  const bass = new Float32Array(frames);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let previous = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[f * HOP + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const magnitude = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
      magnitude[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const rise = magnitude[k] - previous[k];
      if (rise <= 0) continue;
      flux[f] += rise;
      if (k <= low) bass[f] += rise;
    }
    previous = magnitude;
  }

  const mean = average(flux, Math.round(FPS * 0.5));
  const lead = Math.round(FPS * 0.25);
  const onset = flux.map((value, i) => Math.max(0, value - mean[Math.min(frames - 1, i + lead)]));
  onset.fill(0, 0, Math.round(FPS * 0.1));
  const center = onset.reduce((sum, value) => sum + value, 0) / frames;
  const spread = Math.sqrt(onset.reduce((sum, value) => sum + (value - center) ** 2, 0) / frames);
  if (!spread) return null;
  for (let i = 0; i < frames; i++) onset[i] /= spread;

  const correlate = (lag: number) => {
    let sum = 0;
    for (let i = lag; i < frames; i++) sum += onset[i] * onset[i - lag];
    return sum / (frames - lag);
  };
  let lag = 0;
  let best = -Infinity;
  for (
    let candidate = Math.round((FPS * 60) / 220);
    candidate <= Math.round((FPS * 60) / 55);
    candidate++
  ) {
    const prior = Math.exp(-0.5 * (Math.log2((FPS * 60) / candidate / 120) / 0.9) ** 2);
    const score = correlate(candidate) * prior;
    if (score > best) [best, lag] = [score, candidate];
  }
  const [before, at, after] = [correlate(lag - 1), correlate(lag), correlate(lag + 1)];
  const period = lag + (0.5 * (before - after)) / (before - 2 * at + after || 1);

  const score = new Float64Array(frames);
  const from = new Int32Array(frames).fill(-1);
  for (let t = 0; t < frames; t++) {
    let top = 0;
    for (let p = Math.max(0, Math.round(t - 2 * period)); p <= t - Math.round(period / 2); p++) {
      const value = score[p] - 100 * Math.log((t - p) / period) ** 2;
      if (from[t] < 0 || value > top) [top, from[t]] = [value, p];
    }
    score[t] = onset[t] + top;
  }
  let last = frames - 1;
  for (let t = frames - 1; t > frames - 1 - period; t--) if (score[t] > score[last]) last = t;
  const beats: number[] = [];
  for (let t = last; t >= 0; t = from[t]) beats.unshift(t);
  while (beats.length && beats[0] < period / 2 && onset[beats[0]] < 0.05) beats.shift();
  if (beats.length < 8) return null;

  const weight = [0, 1, 2, 3].map((phase) => {
    const own = beats.filter((_, i) => i % 4 === phase);
    return own.reduce((sum, frame) => sum + bass[frame], 0) / own.length;
  });
  return {
    bpm: Math.round(((FPS * 60) / period) * 10) / 10,
    beats: beats.map((frame) => Math.round((frame / FPS + FRAME / 2 / RATE) * 1000) / 1000),
    downbeat: weight.indexOf(Math.max(...weight)),
  };
}

function run(command: string, args: string[], input?: Uint8Array) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${command} exited with ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function measure(start: number, input: string[], bytes?: Uint8Array) {
  const raw = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      ...input,
      "-t",
      String(SECONDS),
      "-ac",
      "1",
      "-ar",
      String(RATE),
      "-f",
      "f32le",
      "pipe:1",
    ],
    bytes,
  );
  const found = findBeats(
    new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)),
  );
  return found && { start, ...found };
}

export async function songBeats(song: {
  preview: string | null;
  libraryTrackId: number | null;
  libraryAlbumId: number | null;
}): Promise<WrappedBeats | null> {
  try {
    if (song.preview) {
      const id = song.preview.match(/\/deezer\/preview\/(\d+)\.mp3$/)?.[1];
      const link = id && (await getDeezerPreviewLink(id));
      if (!link) return null;
      const response = await fetch(link, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return null;
      return await measure(0, ["-i", "pipe:0"], new Uint8Array(await response.arrayBuffer()));
    }
    if (song.libraryTrackId === null || song.libraryAlbumId === null) return null;
    const path = resolveLibraryTrackPath(String(song.libraryAlbumId), String(song.libraryTrackId));
    if (!path) return null;
    const duration = Number(
      String(
        await run("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          path,
        ]),
      ),
    );
    const start = duration > 60 ? Math.round(duration * 0.3) : 0;
    return await measure(start, ["-ss", String(start), "-i", path]);
  } catch {
    return null;
  }
}
