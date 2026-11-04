import { pathToFileURL } from "node:url";
import * as v from "valibot";

type Handler = (input: unknown) => unknown;

const record = v.record(v.string(), v.unknown());
const request = v.object({
  type: v.literal("call"),
  id: v.number(),
  method: v.picklist(["action", "search", "download"]),
  name: v.optional(v.string()),
  input: v.unknown(),
});

const isHandler = (value: unknown): value is Handler => typeof value === "function";
const handlers = (value: unknown) =>
  Object.fromEntries(
    Object.entries(v.is(record, value) ? value : {}).filter((entry): entry is [string, Handler] =>
      isHandler(entry[1]),
    ),
  );
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "unknown error");

function send(message: object) {
  process.send?.(message);
}

process.on("disconnect", () => process.exit(0));

try {
  const loaded: unknown = await import(pathToFileURL(String(process.argv[2])).href);
  const plugin = v.is(record, loaded) && v.is(record, loaded.default) ? loaded.default : loaded;
  const exported = v.is(record, plugin) ? plugin : {};
  const actions = handlers(exported.actions);
  const source = handlers(exported.downloadSource);
  const { search, download } = source;
  const methods = { search, download };

  process.on("message", async (raw) => {
    const parsed = v.safeParse(request, raw);
    if (!parsed.success) return;
    const { id, method, name, input } = parsed.output;
    const handler = method === "action" ? actions[name ?? ""] : methods[method];
    try {
      if (!handler) throw new Error(`${method} ${name ?? ""} is not exported`);
      const value = await handler(input);
      send({ type: "result", id, value: value ?? null });
    } catch (error) {
      send({ type: "error", id, message: errorMessage(error) });
    }
  });
  send({
    type: "ready",
    actions: Object.keys(actions),
    downloadSource: Boolean(search && download),
  });
} catch (error) {
  process.send?.(
    { type: "fatal", message: `index.js failed to load: ${errorMessage(error)}` },
    () => process.exit(1),
  );
}
