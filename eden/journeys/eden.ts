import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as v from "valibot";
import { AurralApi } from "../aurral.ts";
import { LOSSY_LABEL, readWorldManifest } from "../library/generate.ts";
import type { ServiceName } from "../services/index.ts";
import { LOGIN, paths, resolvePorts } from "../state.ts";

// What every journey shares: the running Eden's addresses, which services it has,
// an admin session, and the releases its world offers.

export { until } from "../services/service.ts";

export const ports = await resolvePorts();

const ready = new Set(
  existsSync(paths.done)
    ? v.parse(v.array(v.string()), JSON.parse(readFileSync(paths.done, "utf8")))
    : [],
);
export const has = (...services: ServiceName[]) => services.every((name) => ready.has(name));

export const api = new AurralApi(ports);
await api.login(LOGIN);

const world = readWorldManifest(paths.world);

// Short albums keep a download journey quick. Each journey takes its own.
const short = world.filter((release) => release.files.length >= 8 && release.files.length <= 12);
export function worldRelease(index: number) {
  const release = short[index];
  if (!release) throw new Error(`The world has no short release ${index}`);
  return release;
}

export function lossyRelease() {
  const release = world.find(({ name }) => name.endsWith(LOSSY_LABEL));
  if (!release) throw new Error("The world has no release labelled MP3");
  return release;
}

// Journeys read Aurral's database to see what it recorded. They never write to it.
export function aurralRows(sql: string, ...params: (string | number)[]) {
  const database = new Database(path.join(paths.aurralData, "aurral.db"), { readonly: true });
  try {
    return database.prepare<(string | number)[], Record<string, unknown>>(sql).all(...params);
  } finally {
    database.close();
  }
}

export const getJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  return body;
};
