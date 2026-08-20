import { isVerboseConsoleEnabled } from "../config/constants.js";

const verboseEnabled = isVerboseConsoleEnabled();

const DEFAULT_VISIBLE_MESSAGES = [
  /Server running on port \d+/,
  /Port \d+ is already in use\./,
  /Frontend not built\./,
  /Uncaught Exception:/,
  /Unhandled Rejection:/,
  /Server error:/,
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
  if (verboseEnabled || !String(process.argv[1] || "").endsWith("/server.js")) return;
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
    keys > 0 ? console.error(line, data) : console.error(line);
  } else if (level === "warn") {
    keys > 0 ? console.warn(line, data) : console.warn(line);
  } else {
    keys > 0 ? console.log(line, data) : console.log(line);
  }
}

export const logger = {
  debug: (category, message, data) => log("debug", category, message, data),
  info: (category, message, data) => log("info", category, message, data),
  warn: (category, message, data) => log("warn", category, message, data),
  error: (category, message, data) => log("error", category, message, data),
};
