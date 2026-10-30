import * as v from "valibot";
import { testWebSocketClient } from "../helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [isolatedState, { dbOps }, { getDeprecatedUsage }, { websocketService }] =
  await setupIsolatedBackend(
    "deprecated-usage",
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/deprecatedUsage.ts"),
    () => import("../../backend/services/websocketService.ts"),
  );

const kinds = () =>
  getDeprecatedUsage()
    .map((entry) => entry.kind)
    .sort();

function withEnv(
  values:
    | {
        WEEKLY_FLOW_FOLDER: string;
        PLAYLIST_FOLDER: undefined;
        AUTH_PASSWORD: string;
        AURRAL_DATA_DIR: string;
      }
    | { WEEKLY_FLOW_FOLDER: undefined; PLAYLIST_FOLDER: undefined; AUTH_PASSWORD: undefined },
  run: () => void,
) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("reports configuration that Aurral 3.0 no longer reads", () => {
  withEnv(
    {
      WEEKLY_FLOW_FOLDER: "/data/old-downloads",
      PLAYLIST_FOLDER: undefined,
      AUTH_PASSWORD: "secret",
      AURRAL_DATA_DIR: "/app/backend/data",
    },
    () =>
      assert.deepEqual(kinds(), ["auth-password-env", "download-folder-env", "legacy-data-dir"]),
  );
  withEnv(
    {
      WEEKLY_FLOW_FOLDER: undefined,
      PLAYLIST_FOLDER: undefined,
      AUTH_PASSWORD: undefined,
    },
    () => assert.deepEqual(kinds(), []),
  );
});

test("records old WebSocket channels once per process", async () => {
  const sent: string[] = [];
  const client = testWebSocketClient(1, [], (data) => sent.push(data));

  withEnv(
    { WEEKLY_FLOW_FOLDER: undefined, PLAYLIST_FOLDER: undefined, AUTH_PASSWORD: undefined },
    () => {
      websocketService.handleMessage(
        client,
        Buffer.from(JSON.stringify({ type: "subscribe", channels: ["playlists"] })),
      );
      assert.deepEqual(kinds(), []);
    },
  );

  websocketService.handleMessage(
    client,
    Buffer.from(JSON.stringify({ type: "subscribe", channels: ["weekly-flow"] })),
  );
  const recorded = dbOps.getJSONSetting("deprecatedUsage", v.unknown());
  assert.deepEqual(Object.keys(recorded ?? {}).sort(), ["weekly-flow-channel"]);

  websocketService.handleMessage(
    client,
    Buffer.from(JSON.stringify({ type: "subscribe", channels: ["weekly-flow"] })),
  );
  assert.deepEqual(dbOps.getJSONSetting("deprecatedUsage", v.unknown()), recorded);
  assert.equal(client.subscriptions.has("weekly-flow"), true);
});

test("ignores recorded usage names that are not deprecations", () => {
  dbOps.setJSONSetting("deprecatedUsage", { constructor: { lastSeenAt: 1 } });
  withEnv(
    { WEEKLY_FLOW_FOLDER: undefined, PLAYLIST_FOLDER: undefined, AUTH_PASSWORD: undefined },
    () => assert.deepEqual(kinds(), []),
  );
});
