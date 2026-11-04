import { Hono } from "hono";
import * as v from "valibot";
import { TELEMETRY_PAGES } from "../../lib/telemetry.ts";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import {
  claimTelemetryAsk,
  getTelemetryState,
  noteClientSeen,
  setTelemetryEnabled,
} from "../services/telemetry.ts";
import { buildTelemetryReport } from "../services/telemetryReport.ts";
import { isOfficialBuild } from "../services/updates.ts";

export default new Hono<AppEnv>()
  .basePath("/telemetry")
  .use(requireAuth)
  .post(
    "/seen",
    validate("json", v.object({ page: v.picklist(TELEMETRY_PAGES), standalone: v.boolean() })),
    (c) => {
      const { page, standalone } = c.req.valid("json");
      noteClientSeen(page, standalone, c.req.header("user-agent") ?? "");
      return c.body(null, 204);
    },
  )
  .use(requireAdmin)
  .get("/", noCache, async (c) =>
    c.json(
      {
        ...getTelemetryState(),
        official: isOfficialBuild(),
        report: await buildTelemetryReport(),
      },
      200,
    ),
  )
  .post("/ask", (c) => c.json({ ask: isOfficialBuild() && claimTelemetryAsk() }, 200))
  .put("/", validate("json", v.object({ enabled: v.boolean() })), (c) =>
    c.json(setTelemetryEnabled(c.req.valid("json").enabled), 200),
  );
