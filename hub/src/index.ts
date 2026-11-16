import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { Hono } from "hono";

export type Bindings = { DB: D1Database };

const hub = new Hono<{ Bindings: Bindings }>()
  .basePath("/v1")
  .get("/health", (c) => c.json({ ok: true }));

export type Hub = typeof hub;
export default hub;
