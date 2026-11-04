import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../middleware/requestUser.ts";
import { verifyPluginDevKey } from "../services/plugins/pluginDevKeys.ts";
import {
  callPluginTool,
  PLUGIN_MCP_SERVER,
  PLUGIN_MCP_TOOLS,
  PluginToolError,
} from "../services/plugins/pluginMcp.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const rpcRequest = v.object({
  jsonrpc: v.literal("2.0"),
  id: v.optional(v.union([v.string(), v.number(), v.null()])),
  method: v.string(),
  params: v.optional(v.record(v.string(), v.unknown()), {}),
});
const toolCall = v.object({ name: v.string(), arguments: v.optional(v.unknown()) });

type RpcRequest = v.InferOutput<typeof rpcRequest>;

const result = (id: RpcRequest["id"], value: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  result: value,
});
const failure = (id: RpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

async function handle(request: RpcRequest) {
  const { id, method, params } = request;
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return result(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: PLUGIN_MCP_SERVER.name, version: PLUGIN_MCP_SERVER.version },
      instructions: PLUGIN_MCP_SERVER.instructions,
    });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: PLUGIN_MCP_TOOLS });
  if (method === "tools/call") {
    const call = v.safeParse(toolCall, params);
    if (!call.success) return failure(id, -32602, "tools/call needs a name");
    try {
      const text = await callPluginTool(call.output.name, call.output.arguments);
      return result(id, { content: [{ type: "text", text }] });
    } catch (error) {
      if (!(error instanceof PluginToolError)) throw error;
      return result(id, { content: [{ type: "text", text: error.message }], isError: true });
    }
  }
  return failure(id, -32601, `Unknown method ${method}`);
}

export default new Hono<AppEnv>()
  .basePath("/mcp")
  .use(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!verifyPluginDevKey(key))
      return c.json({ error: "Create a developer key in Settings > Plugins" }, 401);
    await next();
  })
  .get("/", (c) => c.body(null, 405))
  .delete("/", (c) => c.body(null, 405))
  .post("/", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = v.safeParse(rpcRequest, body);
    if (!parsed.success) return c.json(failure(null, -32600, "Send one JSON-RPC 2.0 request"), 400);
    if (parsed.output.id === undefined) return c.body(null, 202);
    return c.json(await handle(parsed.output), 200);
  });
