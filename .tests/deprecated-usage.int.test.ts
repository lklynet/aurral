import * as v from "valibot";
import assert from "node:assert/strict";
import { test, beforeAll, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
  startServerProcess,
} from "./helpers/backendTestHarness.ts";

const [isolatedState, { dbOps }] = await setupIsolatedBackend(
  "deprecated-usage-server",
  () => import("../backend/db/helpers/index.ts"),
);
let server: {
  child: import("node:child_process").ChildProcessByStdio<
    null,
    import("node:stream").Readable,
    import("node:stream").Readable
  >;
  port: number;
  logs: () => string;
  stop(): Promise<void>;
};

beforeAll(async () => {
  server = await startServerProcess();
});

afterAll(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("the old /api/weekly-flow prefix still redirects and records its use", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/weekly-flow/status?limit=1`, {
    redirect: "manual",
  });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/api/playlists/status?limit=1");
  dbOps.invalidateSettingsCache();
  const lastSeenAt = dbOps.getJSONSetting(
    "deprecatedUsage",
    v.record(v.string(), v.looseObject({ lastSeenAt: v.number() })),
  )?.["weekly-flow-api"]?.lastSeenAt;
  assert.ok(lastSeenAt != null && lastSeenAt > 0);
});
