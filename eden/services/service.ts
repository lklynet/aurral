import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import type { AurralApi } from "../aurral.ts";
import type { Ports } from "../state.ts";

export type EdenContext = {
  ports: Ports;
  api: AurralApi;
  restart: (container: string) => void;
  exec: (container: string, ...command: string[]) => string;
  logs: (container: string) => string;
};

export type Service = {
  containers: readonly string[];
  needs?: readonly string[];
  about: (ports: Ports) => string;
  // Settings Aurral only reads from its environment.
  env?: (ports: Ports) => Record<string, string>;
  setup: (context: EdenContext) => Promise<void>;
};

export const local = (port: number) => `http://127.0.0.1:${port}`;

export async function until<Result>(
  what: string,
  check: () => Promise<Result | null | undefined | false>,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check().catch(() => null);
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(500);
  }
}

export async function json(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init).catch((error: unknown) => {
    throw new Error(`${init.method ?? "GET"} ${url} failed`, { cause: error });
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} answered ${response.status}: ${text}`);
  }
  const parsed: unknown = text ? JSON.parse(text) : null;
  return parsed;
}

export const jsonBody = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const savedMappings = v.looseObject({
  pathMappings: v.optional(
    v.array(v.object({ source: v.string(), remote: v.string(), local: v.string() })),
    [],
  ),
});

// A container sees the shared folders at its own paths. A mapping tells Aurral where
// that path is on the host.
export async function addPathMapping(
  api: AurralApi,
  mapping: { source: string; remote: string; local: string },
) {
  const { pathMappings } = v.parse(savedMappings, await api.get("/settings"));
  await api.post("/settings", { pathMappings: [...pathMappings, mapping] });
}

const savedWebhooks = v.looseObject({
  integrations: v.looseObject({ webhooks: v.optional(v.array(v.looseObject({})), []) }),
});

export async function addWebhook(api: AurralApi, webhook: Record<string, unknown>) {
  const { webhooks } = v.parse(savedWebhooks, await api.get("/settings")).integrations;
  await api.post("/settings", { integrations: { webhooks: [...webhooks, webhook] } });
}
