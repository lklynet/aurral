import fs from "node:fs";
import path from "node:path";
import * as v from "valibot";
import { LOG_LEVELS, logEntrySchema, type LogEntry, type LogLevel } from "./logger.ts";

const storedLogEntrySchema = v.object({ id: v.number(), ...logEntrySchema.entries });
export type StoredLogEntry = v.InferOutput<typeof storedLogEntrySchema>;

export type LogQuery = {
  level?: LogLevel;
  cat?: string;
  q?: string;
  fp?: string;
  req?: string;
  job?: string;
  before?: number;
  after?: number;
  since?: number;
  limit: number;
};

export type LogProblem = {
  fp: string;
  level: LogLevel;
  cat: string;
  msg: string;
  count: number;
  firstAt: string;
  lastAt: string;
  latest: StoredLogEntry;
};

const LOG_FILE = "aurral.log";
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_PROBLEMS = 200;
const CLOCK_SKEW_MS = 60_000;
const HEADER = /^\{"id":(\d+),"ts":"([^"]+)","level":"(debug|info|warn|error)"/;

const rotatedName = (index: number) => (index === 0 ? LOG_FILE : `aurral.${index}.log`);

export function createLogWriter(
  dir: string,
  { maxBytes = 10 * 1024 * 1024, files = 5, flushMs = 250 } = {},
) {
  const file = path.join(dir, LOG_FILE);
  let size: number | null = null;
  let lastId = 0;
  let queued: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let reportedFailure = false;

  function rotate() {
    fs.rmSync(path.join(dir, rotatedName(files - 1)), { force: true });
    for (let index = files - 2; index >= 0; index -= 1) {
      const from = path.join(dir, rotatedName(index));
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, rotatedName(index + 1)));
    }
    size = 0;
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!queued.length) return;
    const chunk = queued.join("");
    queued = [];
    try {
      if (size === null) {
        fs.mkdirSync(dir, { recursive: true });
        size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      }
      const bytes = Buffer.byteLength(chunk);
      if (size > 0 && size + bytes > maxBytes) rotate();
      fs.appendFileSync(file, chunk);
      size += bytes;
      reportedFailure = false;
    } catch (error) {
      size = null;
      if (reportedFailure) return;
      reportedFailure = true;
      process.stderr.write(`[error] [logs] Could not write ${file}: ${String(error)}\n`);
    }
  }

  function append(entry: LogEntry) {
    lastId = Math.max(Date.now() * 1000, lastId + 1);
    const { ts, level, ...rest } = entry;
    const stored = { id: lastId, ts, level, ...rest };
    let line = JSON.stringify(stored);
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      line = JSON.stringify({ ...stored, data: "[omitted: too large]" });
    }
    queued.push(`${line}\n`);
    if (!timer) {
      timer = setTimeout(flush, flushMs);
      timer.unref();
    }
  }

  return { append, flush };
}

async function* fileLinesNewestFirst(file: string) {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return;
  }
  try {
    let position = (await handle.stat()).size;
    let tail = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(READ_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, position);
      const data = tail.length ? Buffer.concat([chunk, tail]) : chunk;
      let end = data.length;
      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 0x0a) continue;
        if (end > index + 1) yield data.toString("utf8", index + 1, end);
        end = index;
      }
      tail = Buffer.from(data.subarray(0, end));
    }
    if (tail.length) yield tail.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function* linesNewestFirst(dir: string) {
  for (let index = 0; ; index += 1) {
    const file = path.join(dir, rotatedName(index));
    if (!fs.existsSync(file)) return;
    yield* fileLinesNewestFirst(file);
  }
}

function parseEntry(line: string) {
  try {
    const parsed = v.safeParse(storedLogEntrySchema, JSON.parse(line));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

const levelRank = (level: string) => LOG_LEVELS.findIndex((known) => known === level);

export async function readLogEntries(dir: string, query: LogQuery) {
  const entries: StoredLogEntry[] = [];
  const minRank = query.level ? levelRank(query.level) : 0;
  const text = query.q?.toLowerCase();
  for await (const line of linesNewestFirst(dir)) {
    const header = HEADER.exec(line);
    if (!header) continue;
    const [, rawId, time = "", level = ""] = header;
    const id = Number(rawId);
    if (query.after != null && id <= query.after) break;
    if (query.since != null && Date.parse(time) < query.since) {
      if (Date.parse(time) < query.since - CLOCK_SKEW_MS) break;
      continue;
    }
    if (query.before != null && id >= query.before) continue;
    if (levelRank(level) < minRank) continue;
    if (text && !line.toLowerCase().includes(text)) continue;
    const entry = parseEntry(line);
    if (!entry) continue;
    if (query.cat && entry.cat !== query.cat) continue;
    if (query.fp && entry.fp !== query.fp) continue;
    if (query.req && entry.req !== query.req) continue;
    if (query.job && entry.job !== query.job) continue;
    entries.push(entry);
    if (entries.length >= query.limit) break;
  }
  return entries;
}

export async function readLogProblems(dir: string, { since }: { since: number }) {
  const problems = new Map<string, LogProblem>();
  const warnRank = levelRank("warn");
  for await (const line of linesNewestFirst(dir)) {
    const header = HEADER.exec(line);
    if (!header) continue;
    const [, , time = "", level = ""] = header;
    if (Date.parse(time) < since) {
      if (Date.parse(time) < since - CLOCK_SKEW_MS) break;
      continue;
    }
    if (levelRank(level) < warnRank) continue;
    const entry = parseEntry(line);
    if (!entry) continue;
    const known = problems.get(entry.fp);
    if (known) {
      known.count += 1;
      known.firstAt = entry.ts;
    } else if (problems.size < MAX_PROBLEMS) {
      problems.set(entry.fp, {
        fp: entry.fp,
        level: entry.level,
        cat: entry.cat,
        msg: entry.msg,
        count: 1,
        firstAt: entry.ts,
        lastAt: entry.ts,
        latest: entry,
      });
    }
  }
  return [...problems.values()];
}
