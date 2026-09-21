import { isVerboseConsoleEnabled } from "../config/constants.js";

const verboseEnabled = isVerboseConsoleEnabled();

const MAX_LOG_DIAGNOSTIC_LENGTH = 500;

export function safeLogDiagnostic(value) {
  const raw = typeof value?.message === "string" ? value.message : String(value ?? "");
  const isHtml = /^\s*(?:<!doctype html|<html\b)/i.test(raw);
  const status = Number(value?.statusCode ?? value?.response?.status);
  const title = isHtml ? raw.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim() : null;
  const diagnostic = isHtml
    ? `Upstream HTML error${Number.isInteger(status) && status >= 400 ? ` (${status})` : ""}${title ? `: ${title}` : ""}`
    : raw;
  const redacted = diagnostic
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'}]+/gi, "$1 [redacted]")
    .replace(/\b(cookie|set-cookie)\b["']?\s*[:=]\s*[^\r\n}]+/gi, "$1=[redacted]")
    .replace(/["']?\b(arl|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|token|session|password|secret|authorization)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1=[redacted]")
    .replace(/\b[a-f0-9]{64,}\b/gi, "[redacted]")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim();
  return redacted.length > MAX_LOG_DIAGNOSTIC_LENGTH
    ? `${redacted.slice(0, MAX_LOG_DIAGNOSTIC_LENGTH)}…`
    : redacted;
}

const DEFAULT_VISIBLE_MESSAGES = [
  /Server running on port \d+/,
  /Port \d+ is already in use\./,
  /Frontend not built\./,
  /Uncaught Exception:/,
  /Unhandled Rejection:/,
  /Server error:/,
  /Playlist import (queued|job completed|sync completed)/,
];

const messageText = (args) =>
  args
    .map((value) =>
      value instanceof Error ? value.message : typeof value === "string" ? value : "",
    )
    .filter(Boolean)
    .join(" ");

export const shouldEmitDefaultConsoleMessage = (method, args = []) => {
  if (method === "debug") return false;
  if (method === "warn" || method === "error") return true;
  return DEFAULT_VISIBLE_MESSAGES.some((pattern) =>
    pattern.test(messageText(args)),
  );
};

function patchDefaultConsole() {
  if (verboseEnabled || !/(?:^|[\\/])server\.js$/.test(String(process.argv[1] || ""))) return;
  if (globalThis.__aurralDefaultConsolePatched) return;
  globalThis.__aurralDefaultConsolePatched = true;

  for (const method of ["log", "info", "debug"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      if (shouldEmitDefaultConsoleMessage(method, args)) original(...args);
    };
  }
}

patchDefaultConsole();

function log(level, category, message, data = {}) {
  if (!verboseEnabled && level === "debug") return;
  if (
    !verboseEnabled &&
    level === "info" &&
    !DEFAULT_VISIBLE_MESSAGES.some((pattern) => pattern.test(String(message)))
  ) return;
  const line = `[${level}] [${category}] ${message}`;
  const keys = Object.keys(data).length;
  if (level === "error") {
    keys > 0 ? console.error("%s", line, data) : console.error("%s", line);
  } else if (level === "warn") {
    keys > 0 ? console.warn("%s", line, data) : console.warn("%s", line);
  } else {
    keys > 0 ? console.log("%s", line, data) : console.log("%s", line);
  }
}

export const logger = {
  debug: (category, message, data) => log("debug", category, message, data),
  info: (category, message, data) => log("info", category, message, data),
  warn: (category, message, data) => log("warn", category, message, data),
  error: (category, message, data) => log("error", category, message, data),
};
