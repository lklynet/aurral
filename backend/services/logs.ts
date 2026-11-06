import os from "node:os";
import path from "node:path";
import * as v from "valibot";
import { onRequestFailure } from "../../lib/axiosFetch.ts";
import { APP_VERSION } from "../config/constants.ts";
import { resolveAurralDataDir } from "../config/data-dir.ts";
import { dbOps } from "../db/helpers/index.ts";
import {
  createLogWriter,
  readLogEntries,
  readLogProblems,
  type LogQuery,
  type StoredLogEntry,
} from "./logFile.ts";
import { recordLog, refreshDebugLogging, startLogSink, type LogLevel } from "./logger.ts";
import { isRunningInDocker } from "./runtimeInfo.ts";

const LOG_DIR = path.join(resolveAurralDataDir(), "logs");
const DEBUG_SETTING = "debugLogging";
const FRESH_SETTING = "logsFreshSince";
const MAX_EXPORT_ENTRIES = 20000;
const AUTH_FAILURE_STATUSES = new Set([401, 403, 407]);
const TOKEN_SEGMENT = /^[\w:.-]{20,}$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const safePath = (pathname: string) =>
  pathname
    .split("/")
    .map((segment) => (TOKEN_SEGMENT.test(segment) && !UUID.test(segment) ? "***" : segment))
    .join("/");

export const isDebugLoggingOn = () => dbOps.getJSONSetting(DEBUG_SETTING, v.boolean()) === true;

export const getFreshSince = () =>
  dbOps.getJSONSetting(FRESH_SETTING, v.nullable(v.number())) ?? null;

export const setFreshSince = (since: number | null) => dbOps.setJSONSetting(FRESH_SETTING, since);

const afterFresh = (since: number) => Math.max(since, getFreshSince() ?? 0);

export function setDebugLogging(enabled: boolean) {
  dbOps.setJSONSetting(DEBUG_SETTING, enabled);
  refreshDebugLogging();
}

export function logOutgoingFailures() {
  onRequestFailure(({ method, url, status, code, ms, message }) => {
    const { host, pathname } = new URL(url);
    const level =
      status === null || status >= 500 || AUTH_FAILURE_STATUSES.has(status) ? "warn" : "debug";
    recordLog(
      level,
      "http",
      `${method} ${host} ${status ? `returned ${status}` : "failed"}`,
      { path: safePath(pathname), ms, ...(code && { code }), reason: message },
      { groupByMessage: true },
    );
  });
}

export function startMainLogging() {
  const writer = createLogWriter(LOG_DIR);
  process.on("exit", writer.flush);
  startLogSink(writer.append, { debugEnabled: isDebugLoggingOn });
  logOutgoingFailures();
}

export function startWorkerLogging() {
  startLogSink(
    (entry) => {
      if (process.connected) process.send?.({ type: "log", entry });
    },
    { debugEnabled: isDebugLoggingOn },
  );
  logOutgoingFailures();
}

export const queryLogs = (query: LogQuery) => readLogEntries(LOG_DIR, query);

export const listLogProblems = (since: number) =>
  readLogProblems(LOG_DIR, { since: afterFresh(since) });

function enabledIntegrations() {
  return Object.entries(dbOps.getSettings().integrations ?? {})
    .filter(([, service]) => {
      if (!service || typeof service !== "object") return false;
      const enabled = Reflect.get(service, "enabled");
      const url = Reflect.get(service, "url");
      return enabled === true || (enabled !== false && typeof url === "string" && url.length > 0);
    })
    .map(([name]) => name)
    .sort();
}

function formatEntry(entry: StoredLogEntry) {
  const where = [
    entry.proc === "main" ? null : entry.proc,
    entry.req ? `req=${entry.req}` : null,
    entry.job ? `job=${entry.job}` : null,
  ].filter(Boolean);
  const lines = [
    `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.cat}] ${entry.msg}${where.length ? ` (${where.join(" ")})` : ""}`,
  ];
  if (entry.data !== undefined) lines.push(`  ${JSON.stringify(entry.data)}`);
  if (entry.err) {
    lines.push(`  ${entry.err.name}: ${entry.err.message}`);
    for (const frame of entry.err.stack?.split("\n") ?? []) lines.push(`    ${frame}`);
  }
  return lines.join("\n");
}

export async function exportLogs({ since: window, level }: { since: number; level: LogLevel }) {
  const since = afterFresh(window);
  const freshSince = getFreshSince();
  const entries = await readLogEntries(LOG_DIR, { since, level, limit: MAX_EXPORT_ENTRIES });
  const header = [
    `Aurral ${APP_VERSION}${(await isRunningInDocker()) ? " (Docker)" : ""}`,
    `Node ${process.versions.node} on ${os.platform()} ${os.arch()}`,
    `Running for ${Math.round(process.uptime() / 60)} min, exported ${new Date().toISOString()}`,
    `Integrations: ${enabledIntegrations().join(", ") || "none"}`,
    `Debug logging: ${isDebugLoggingOn() ? "on" : "off"}`,
    `Showing ${level} and above since ${new Date(since).toISOString()}, ${entries.length} lines`,
    ...(freshSince && freshSince >= window
      ? [
          `Started fresh at ${new Date(freshSince).toISOString()}; earlier problems were already reviewed`,
        ]
      : []),
  ];
  return `${header.join("\n")}\n\n${entries.reverse().map(formatEntry).join("\n")}\n`;
}
