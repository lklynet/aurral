import { isVerboseConsoleEnabled } from "../config/constants.ts";

const verboseEnabled = isVerboseConsoleEnabled();

const MAX_LOG_DIAGNOSTIC_LENGTH = 500;
const MAX_HTML_TITLE_SCAN_LENGTH = 8192;
const SENSITIVE_LOG_KEY =
  /^(?:arl|authorization|(?:set[_-]?)?cookie|password|(?:client[_-]?)?secret|session|(?:access[_-]?|refresh[_-]?|auth[_-]?)?token|(?:x[_-]?)?api[_-]?key)$/i;

declare global {
  var __aurralDefaultConsolePatched: boolean | undefined;
}

type Diagnosable =
  | { message?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  | null
  | undefined;
type LogLevel = "debug" | "info" | "warn" | "error";

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

function patchDefaultConsole() {
  if (verboseEnabled || !/(?:^|[\\/])server\.ts$/.test(String(process.argv[1] || ""))) return;
  if (globalThis.__aurralDefaultConsolePatched) return;
  globalThis.__aurralDefaultConsolePatched = true;

  for (const method of ["log", "info", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      if (shouldEmitDefaultConsoleMessage(method, args)) original(...args);
    };
  }
}

patchDefaultConsole();

function log(level: LogLevel, category: string, message: string, data: NonNullable<unknown> = {}) {
  if (!verboseEnabled && level === "debug") return;
  if (
    !verboseEnabled &&
    level === "info" &&
    !DEFAULT_VISIBLE_MESSAGES.some((pattern) => pattern.test(String(message)))
  )
    return;
  const line = `[${level}] [${safeLogDiagnostic(category)}] ${safeLogDiagnostic(message)}`;
  const keys = Object.keys(data).length;
  const safeData = keys > 0 ? safeLogData(data) : data;
  if (level === "error") {
    if (keys > 0) console.error("%s", line, safeData);
    else console.error("%s", line);
  } else if (level === "warn") {
    if (keys > 0) console.warn("%s", line, safeData);
    else console.warn("%s", line);
  } else {
    if (keys > 0) console.log("%s", line, safeData);
    else console.log("%s", line);
  }
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
