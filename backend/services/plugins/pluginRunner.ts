import { pathToFileURL } from "node:url";
import { format } from "node:util";
import * as v from "valibot";

type Handler = (input: unknown) => unknown;

const record = v.record(v.string(), v.unknown());
const request = v.object({
  type: v.literal("call"),
  id: v.number(),
  path: v.string(),
  input: v.unknown(),
});

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "unknown error");

function exportedHandlers(plugin: Record<string, unknown>) {
  const found = new Map<string, Handler>();
  for (const [name, value] of Object.entries(plugin)) {
    if (typeof value === "function") found.set(name, (input) => value.call(plugin, input));
    if (!v.is(record, value)) continue;
    for (const [child, handler] of Object.entries(value)) {
      if (typeof handler === "function")
        found.set(`${name}.${child}`, (input) => handler.call(value, input));
    }
  }
  return found;
}

function send(message: object) {
  process.send?.(message);
}

process.on("disconnect", () => process.exit(0));

for (const [method, level] of [
  ["log", "info"],
  ["info", "info"],
  ["debug", "info"],
  ["warn", "warn"],
  ["error", "warn"],
] as const)
  console[method] = (...args: unknown[]) => send({ type: "log", level, message: format(...args) });

try {
  const loaded: unknown = await import(pathToFileURL(String(process.argv[2])).href);
  const plugin = v.is(record, loaded) && v.is(record, loaded.default) ? loaded.default : loaded;
  const handlers = exportedHandlers(v.is(record, plugin) ? plugin : {});

  process.on("message", async (raw) => {
    const parsed = v.safeParse(request, raw);
    if (!parsed.success) return;
    const { id, path, input } = parsed.output;
    try {
      const handler = handlers.get(path);
      if (!handler) throw new Error(`${path} is not exported`);
      const value = await handler(input);
      send({ type: "result", id, value: value ?? null });
    } catch (error) {
      send({ type: "error", id, message: errorMessage(error) });
    }
  });
  send({ type: "ready", exports: [...handlers.keys()] });
} catch (error) {
  process.send?.(
    { type: "fatal", message: `index.js failed to load: ${errorMessage(error)}` },
    () => process.exit(1),
  );
}
