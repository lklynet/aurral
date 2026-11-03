import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { formatWithOptions } from "node:util";
import * as v from "valibot";
import { isVerboseConsoleEnabled } from "../config/constants.ts";

const verboseEnabled = isVerboseConsoleEnabled();

const MAX_LOG_DIAGNOSTIC_LENGTH = 500;
const MAX_HTML_TITLE_SCAN_LENGTH = 8192;
const MAX_STACK_FRAMES = 15;
const MAX_EARLY_ENTRIES = 500;
const DEBUG_SETTING_TTL_MS = 5000;
const SENSITIVE_LOG_KEY =
  /^(?:arl|authorization|(?:set[_-]?)?cookie|password|(?:client[_-]?)?secret|session|(?:access[_-]?|refresh[_-]?|auth[_-]?)?token|(?:x[_-]?)?api[_-]?key)$/i;

declare global {
  var __aurralConsoleCaptured: boolean | undefined;
}

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogContext = { req?: string; job?: string };

export const logEntrySchema = v.object({
  ts: v.string(),
  level: v.picklist(LOG_LEVELS),
  cat: v.string(),
  msg: v.string(),
  proc: v.string(),
  fp: v.string(),
  req: v.optional(v.string()),
  job: v.optional(v.string()),
  data: v.optional(v.unknown()),
  err: v.optional(
    v.object({
      name: v.string(),
      message: v.string(),
      code: v.optional(v.string()),
      stack: v.optional(v.string()),
    }),
  ),
});
export type LogEntry = v.InferOutput<typeof logEntrySchema>;
type LogError = NonNullable<LogEntry["err"]>;

type Diagnosable =
  | { message?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  | null
  | undefined;
type ConsoleMethod = "debug" | "log" | "info" | "warn" | "error";

const PROCESS_NAME = process.env.AURRAL_BACKGROUND_WORKER_GROUP || "main";
const CONSOLE_LEVEL = {
  debug: "debug",
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
} as const satisfies Record<ConsoleMethod, LogLevel>;

function htmlErrorTitle(raw: string) {
  const head = raw.slice(0, MAX_HTML_TITLE_SCAN_LENGTH);
  const lowerHead = head.toLowerCase();
  const start = lowerHead.indexOf("<title");
  if (start < 0) return null;
  const openEnd = head.indexOf(">", start + 6);
  const nextTag = head.indexOf("<", start + 1);
  if (openEnd < 0 || openEnd - start > 256 || (nextTag >= 0 && nextTag < openEnd)) return null;
  const close = lowerHead.indexOf("</title>", openEnd + 1);
  const nestedTag = head.indexOf("<", openEnd + 1);
  if (close < 0 || close - openEnd - 1 > 200 || nestedTag !== close) return null;
  return head.slice(openEnd + 1, close).trim() || null;
}

export function safeLogDiagnostic(value: unknown) {
  const raw =
    typeof (value as Diagnosable)?.message === "string"
      ? (value as { message: string }).message
      : String(value ?? "");
  const isHtml = /^\s*(?:<!doctype html|<html\b)/i.test(raw);
  const status = Number(
    (value as Diagnosable)?.statusCode ?? (value as Diagnosable)?.response?.status,
  );
  const title = isHtml ? htmlErrorTitle(raw) : null;
  const diagnostic = isHtml
    ? `Upstream HTML error${Number.isInteger(status) && status >= 400 ? ` (${status})` : ""}${title ? `: ${title}` : ""}`
    : raw;
  const masked = diagnostic
    .replace(/(https?:\/\/)[^/@\s]*@/gi, "$1***@")
    .replace(/\b(cookie|set-cookie)\b["']?\s*[:=]\s*[^\r\n}]+/gi, "$1=***")
    .replace(
      /["']?\b(arl|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|token|session|password|secret|authorization)\b["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      "$1=***",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'}]+/gi, "$1 ***")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim();
  return masked.length > MAX_LOG_DIAGNOSTIC_LENGTH
    ? `${masked.slice(0, MAX_LOG_DIAGNOSTIC_LENGTH)}…`
    : masked;
}

function safeLogData(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string" || value instanceof Error) return safeLogDiagnostic(value);
  if (typeof value === "bigint") return String(value);
  if (value == null || typeof value !== "object") return value;
  if (depth >= 5 || seen.has(value)) return "[omitted]";
  seen.add(value);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => safeLogData(item, depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_LOG_KEY.test(key) ? "***" : safeLogData(item, depth + 1, seen),
    ]),
  );
}

function describeError(error: Error): LogError {
  const code = Reflect.get(error, "code");
  const stack = error.stack
    ?.split("\n")
    .filter((line) => /^\s+at |@\S+:\d+/.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => safeLogDiagnostic(line.trim()))
    .join("\n");
  return {
    name: safeLogDiagnostic(error.name),
    message: safeLogDiagnostic(error),
    ...(typeof code === "string" || typeof code === "number" ? { code: String(code) } : {}),
    ...(stack ? { stack } : {}),
  };
}

function findError(value: unknown) {
  if (value instanceof Error) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.values(value).find((item) => item instanceof Error);
}

const normalizedForFingerprint = (text: string) =>
  text
    .replace(/"[^"]*"|'[^']*'|“[^”]*”/g, '""')
    .replace(/\b[0-9a-f]{8,}(?:-[0-9a-f]{4,})*\b/gi, "#")
    .replace(/\d+/g, "#");

function fingerprint(level: LogLevel, cat: string, msg: string, reason: string | undefined) {
  const key = [level, cat, msg, reason ?? ""].map(normalizedForFingerprint).join("\0");
  return createHash("sha1").update(key).digest("hex").slice(0, 10);
}

const context = new AsyncLocalStorage<LogContext>();

export const withLogContext = <T>(next: LogContext, run: () => T) =>
  context.run({ ...context.getStore(), ...next }, run);

let sink: ((entry: LogEntry) => void) | null = null;
let earlyEntries: LogEntry[] = [];
let readDebugSetting = () => false;
let debugSetting = { value: false, readAt: 0 };

export function startLogSink(
  write: (entry: LogEntry) => void,
  { debugEnabled }: { debugEnabled?: () => boolean } = {},
) {
  sink = write;
  if (debugEnabled) {
    readDebugSetting = debugEnabled;
    debugSetting = { value: false, readAt: 0 };
  }
  const pending = earlyEntries;
  earlyEntries = [];
  for (const entry of pending) writeLogEntry(entry);
}

export function writeLogEntry(entry: LogEntry) {
  if (!sink) {
    earlyEntries.push(entry);
    if (earlyEntries.length > MAX_EARLY_ENTRIES) earlyEntries.shift();
    return;
  }
  try {
    sink(entry);
  } catch {}
}

export function refreshDebugLogging() {
  debugSetting.readAt = 0;
}

function isDebugLogging() {
  if (verboseEnabled) return true;
  const now = Date.now();
  if (now - debugSetting.readAt > DEBUG_SETTING_TTL_MS) {
    let value = false;
    try {
      value = readDebugSetting();
    } catch {}
    debugSetting = { value, readAt: now };
  }
  return debugSetting.value;
}

const isEmpty = (data: unknown) =>
  data == null ||
  (typeof data === "object" && !(data instanceof Error) && Object.keys(data).length === 0);

function record(level: LogLevel, cat: string, msg: string, data?: unknown, error?: Error) {
  if (level === "debug" && !isDebugLogging()) return;
  const err = error ? describeError(error) : undefined;
  const rest =
    error && data && typeof data === "object" && !Array.isArray(data) && data !== error
      ? Object.fromEntries(Object.entries(data).filter(([, value]) => value !== error))
      : data;
  const safeData = isEmpty(rest) || rest === error ? undefined : safeLogData(rest);
  const reason =
    err?.message ??
    (safeData && typeof safeData === "object" && "reason" in safeData
      ? String(safeData.reason)
      : undefined);
  writeLogEntry({
    ts: new Date().toISOString(),
    level,
    cat,
    msg,
    proc: PROCESS_NAME,
    fp: fingerprint(level, cat, msg, reason),
    ...context.getStore(),
    ...(safeData === undefined ? {} : { data: safeData }),
    ...(err ? { err } : {}),
  });
}

const DEFAULT_VISIBLE_MESSAGES = [
  /Server running on port \d+/,
  /Port \d+ is already in use\./,
  /Frontend not built\./,
  /Uncaught Exception:/,
  /Unhandled Rejection:/,
  /Server error:/,
  /Playlist import (queued|job completed|sync completed)/,
  /Restored a backup\./,
];

const messageText = (args: unknown[]) =>
  args
    .map((value) =>
      value instanceof Error ? value.message : typeof value === "string" ? value : "",
    )
    .filter(Boolean)
    .join(" ");

export const shouldEmitDefaultConsoleMessage = (method: string, args: unknown[] = []) => {
  if (method === "debug") return false;
  if (method === "warn" || method === "error") return true;
  return DEFAULT_VISIBLE_MESSAGES.some((pattern) => pattern.test(messageText(args)));
};

let echoing = false;

function echo(method: "log" | "warn" | "error", line: string, data: unknown) {
  echoing = true;
  try {
    if (data === undefined) console[method]("%s", line);
    else console[method]("%s", line, data);
  } finally {
    echoing = false;
  }
}

const consoleCategory = (tag: string) =>
  tag
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();

export function recordConsoleCall(method: ConsoleMethod, args: unknown[]) {
  const error = args.find((arg) => arg instanceof Error);
  const text = formatWithOptions(
    { breakLength: Infinity, depth: 4, colors: false },
    ...args.map((arg) => (arg instanceof Error ? arg.message : arg)),
  );
  const tagged = /^\s*\[([^\]\n]{1,40})\]:?\s*/.exec(text);
  const cat = tagged ? consoleCategory(tagged[1] ?? "") : "console";
  const msg = safeLogDiagnostic(tagged ? text.slice(tagged[0].length) : text);
  record(CONSOLE_LEVEL[method], cat, msg, undefined, error);
}

const isAppProcess = () =>
  Boolean(process.env.AURRAL_BACKGROUND_WORKER_GROUP) ||
  /(?:^|[\\/])server\.ts$/.test(String(process.argv[1] || ""));

function captureConsole() {
  if (!isAppProcess() || globalThis.__aurralConsoleCaptured) return;
  globalThis.__aurralConsoleCaptured = true;
  for (const method of Object.keys(CONSOLE_LEVEL) as ConsoleMethod[]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      if (echoing) return original(...args);
      recordConsoleCall(method, args);
      if (verboseEnabled || shouldEmitDefaultConsoleMessage(method, args)) original(...args);
    };
  }
}

captureConsole();

function log(level: LogLevel, category: string, message: string, data?: unknown) {
  const cat = safeLogDiagnostic(category);
  const msg = safeLogDiagnostic(message);
  record(level, cat, msg, data, findError(data));
  if (!verboseEnabled && level === "debug") return;
  if (
    !verboseEnabled &&
    level === "info" &&
    !DEFAULT_VISIBLE_MESSAGES.some((pattern) => pattern.test(String(message)))
  )
    return;
  echo(
    level === "error" ? "error" : level === "warn" ? "warn" : "log",
    `[${level}] [${cat}] ${msg}`,
    isEmpty(data) ? undefined : safeLogData(data),
  );
}

export function recordLog(
  level: LogLevel,
  category: string,
  message: string,
  data?: NonNullable<unknown>,
  error = findError(data),
) {
  record(level, safeLogDiagnostic(category), safeLogDiagnostic(message), data, error);
}

export type RuntimeLogger = Pick<Console, "info" | "warn" | "error">;

export const logger = {
  debug: (category: string, message: string, data?: NonNullable<unknown>) =>
    log("debug", category, message, data),
  info: (category: string, message: string, data?: NonNullable<unknown>) =>
    log("info", category, message, data),
  warn: (category: string, message: string, data?: NonNullable<unknown>) =>
    log("warn", category, message, data),
  error: (category: string, message: string, data?: NonNullable<unknown>) =>
    log("error", category, message, data),
};

export const logUnhandledRejection = (reason: unknown) =>
  logger.error("system", "Unhandled Rejection:", reason ?? undefined);
