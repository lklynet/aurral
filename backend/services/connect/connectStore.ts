import os from "node:os";
import * as v from "valibot";
import { normalizeLanHints } from "../../../lib/connectTokens.ts";
import { dbOps } from "../../db/helpers/index.ts";

const SETTINGS_KEY = "connect";

const connectConfigSchema = v.object({
  enabled: v.optional(v.boolean(), false),
  allowHubSignIn: v.optional(v.boolean(), false),
  slug: v.optional(v.nullable(v.string()), null),
  name: v.optional(v.nullable(v.string()), null),
  connectUrl: v.optional(v.nullable(v.string()), null),
  hubOrigin: v.optional(v.nullable(v.string()), null),
});

export type ConnectConfig = v.InferOutput<typeof connectConfigSchema>;

const DEFAULT_CONFIG: ConnectConfig = {
  enabled: false,
  allowHubSignIn: false,
  slug: null,
  name: null,
  connectUrl: null,
  hubOrigin: null,
};

export function getConnectConfig(): ConnectConfig {
  const stored = dbOps.getJSONSetting(SETTINGS_KEY, connectConfigSchema);
  return stored ? { ...DEFAULT_CONFIG, ...stored } : { ...DEFAULT_CONFIG };
}

export function setConnectConfig(update: Partial<ConnectConfig>): ConnectConfig {
  const next: ConnectConfig = { ...getConnectConfig(), ...update };
  dbOps.setJSONSetting(SETTINGS_KEY, next);
  return next;
}

export function detectLanHints(port = Number(process.env.PORT || 3001)): string[] {
  let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const details of Object.values(interfaces)) {
    for (const detail of details ?? []) {
      if (!detail || detail.internal || detail.family !== "IPv4") continue;
      if (
        detail.address.startsWith("10.") ||
        detail.address.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(detail.address)
      ) {
        candidates.push(`http://${detail.address}:${port}`);
      }
    }
  }
  return normalizeLanHints(candidates);
}
