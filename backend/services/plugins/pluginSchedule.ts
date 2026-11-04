import * as v from "valibot";
import { callPlugin } from "./pluginHost.ts";
import type { PluginSchedule } from "./pluginManifest.ts";
import { activePlugins, isCapabilityOn, markPluginScheduled, pluginInput } from "./pluginStore.ts";

const RUN_TIMEOUT_MS = 10 * 60_000;
const SWEEP_SLACK_MS = 60_000;
const INTERVAL_MS: Record<PluginSchedule, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

export async function runDuePluginSchedules(now = Date.now()) {
  const due = activePlugins().flatMap((plugin) => {
    const schedule = plugin.manifest.schedule;
    if (!schedule || !isCapabilityOn(plugin, "schedule")) return [];
    const since = now - (plugin.scheduledAt ?? 0);
    return since >= INTERVAL_MS[schedule] - SWEEP_SLACK_MS ? [plugin] : [];
  });
  await Promise.allSettled(
    due.map((plugin) => {
      markPluginScheduled(plugin.id, now);
      return callPlugin(
        plugin,
        { path: "scheduled", input: pluginInput(plugin) },
        v.unknown(),
        RUN_TIMEOUT_MS,
      );
    }),
  );
  return due.map((plugin) => plugin.id);
}
