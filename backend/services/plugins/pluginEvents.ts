import * as v from "valibot";
import { logger } from "../logger.ts";
import { enqueueNotification, parseHonkerPayload } from "../honkerDb.ts";
import { callPlugin, PluginError } from "./pluginHost.ts";
import { PLUGIN_EVENTS, type PluginEvent } from "./pluginManifest.ts";
import { activePluginWith, pluginInput, pluginsForEvent } from "./pluginStore.ts";

const EVENT_TIMEOUT_MS = 10_000;

export const pluginEventDeliverySchema = v.object({
  kind: v.literal("plugin"),
  pluginId: v.string(),
  event: v.picklist(PLUGIN_EVENTS),
  data: v.record(v.string(), v.unknown()),
});

export function emitPluginEvent(event: PluginEvent, data: Record<string, unknown>) {
  try {
    const plugins = pluginsForEvent(event);
    if (!plugins.length) return;
    const payload = parseHonkerPayload(JSON.stringify(data));
    if (!payload) return;
    for (const plugin of plugins)
      enqueueNotification({ kind: "plugin", pluginId: plugin.id, event, data: payload });
  } catch (error) {
    logger.warn("plugins", "Could not queue a plugin event", {
      event,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function dispatchPluginEvent(payload: v.InferOutput<typeof pluginEventDeliverySchema>) {
  deliverPluginEvent(payload).catch((error: unknown) => {
    if (error instanceof PluginError) return;
    logger.warn("plugins", "Could not deliver a plugin event", {
      event: payload.event,
      pluginId: payload.pluginId,
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function deliverPluginEvent({
  pluginId,
  event,
  data,
}: v.InferOutput<typeof pluginEventDeliverySchema>) {
  const plugin = activePluginWith(pluginId, `event:${event}`);
  if (!plugin?.manifest.events.includes(event)) return;
  await callPlugin(
    plugin,
    { path: `events.${event}`, input: { ...pluginInput(plugin), event, ...data } },
    v.unknown(),
    EVENT_TIMEOUT_MS,
  );
}
