import * as v from "valibot";
import {
  SEEN_GROUPS,
  TELEMETRY_INTERVAL_MS,
  describeUserAgent,
  subsonicClientName,
  type SeenGroup,
  type SeenKey,
  type TelemetryPage,
} from "../../lib/telemetry.ts";
import { dbOps } from "../db/helpers/index.ts";

const STATE_SETTING = "telemetry";
const SEEN_SETTING = "telemetry:seen";
const NOTE_EVERY_MS = 60 * 60 * 1000;

const stateSchema = v.object({
  enabled: v.boolean(),
  askedAt: v.nullable(v.number()),
  lastSentAt: v.nullable(v.number()),
});
const seenSchema = v.record(v.string(), v.number());

const DEFAULT_STATE: v.InferOutput<typeof stateSchema> = {
  enabled: false,
  askedAt: null,
  lastSentAt: null,
};

export const getTelemetryState = () =>
  dbOps.getJSONSetting(STATE_SETTING, stateSchema) ?? DEFAULT_STATE;

const notedAt = new Map<SeenKey, number>();

export function claimTelemetryAsk() {
  const state = getTelemetryState();
  if (state.askedAt !== null) return false;
  dbOps.setJSONSetting(STATE_SETTING, { ...state, askedAt: Date.now() });
  return true;
}

export function setTelemetryEnabled(enabled: boolean) {
  const next = { ...getTelemetryState(), enabled, askedAt: Date.now() };
  dbOps.setJSONSetting(STATE_SETTING, next);
  if (!enabled) dbOps.setJSONSetting(SEEN_SETTING, {});
  notedAt.clear();
  return next;
}

function noteSeen(keys: SeenKey[], now = Date.now()) {
  const fresh = keys.filter((key) => now - (notedAt.get(key) ?? 0) >= NOTE_EVERY_MS);
  if (fresh.length === 0) return;
  for (const key of fresh) notedAt.set(key, now);
  if (!getTelemetryState().enabled) return;
  const seen = Object.fromEntries(
    Object.entries(dbOps.getJSONSetting(SEEN_SETTING, seenSchema) ?? {}).filter(
      ([, at]) => now - at < TELEMETRY_INTERVAL_MS,
    ),
  );
  for (const key of fresh) seen[key] = now;
  dbOps.setJSONSetting(SEEN_SETTING, seen);
}

export function noteClientSeen(page: TelemetryPage, standalone: boolean, userAgent: string) {
  const { device, os, browser } = describeUserAgent(userAgent);
  noteSeen([
    `pages:${page}`,
    `devices:${device}`,
    `os:${os}`,
    `browsers:${browser}`,
    ...(standalone ? (["display:pwa"] as const) : []),
  ]);
}

export const noteSubsonicClient = (client: string) =>
  noteSeen([`subsonicClients:${subsonicClientName(client)}`]);

export function seenSince(since: number) {
  const seen = dbOps.getJSONSetting(SEEN_SETTING, seenSchema) ?? {};
  const pick = <Value extends string>(group: SeenGroup, values: readonly Value[]) =>
    values.filter((value) => (seen[`${group}:${value}`] ?? 0) >= since);
  return {
    pages: pick("pages", SEEN_GROUPS.pages),
    devices: pick("devices", SEEN_GROUPS.devices),
    os: pick("os", SEEN_GROUPS.os),
    browsers: pick("browsers", SEEN_GROUPS.browsers),
    subsonicClients: pick("subsonicClients", SEEN_GROUPS.subsonicClients),
    display: pick("display", SEEN_GROUPS.display),
  };
}

export const markTelemetrySent = (at: number) =>
  dbOps.setJSONSetting(STATE_SETTING, { ...getTelemetryState(), lastSentAt: at });
