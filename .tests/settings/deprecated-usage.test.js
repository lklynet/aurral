import assert from "node:assert/strict";
import test from "node:test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { dbOps },
  { getDeprecatedUsage },
  { websocketService },
] = await setupIsolatedBackend(
  "deprecated-usage",
  "backend/db/helpers/index.js",
  "backend/services/deprecatedUsage.js",
  "backend/services/websocketService.js",
);

const kinds = () => getDeprecatedUsage().map((entry) => entry.kind).sort();

function withEnv(values, run) {
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

test.after(async () => {
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
    () => assert.deepEqual(kinds(), ["auth-password-env", "download-folder-env", "legacy-data-dir"]),
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
  const sent = [];
  const client = { subscriptions: new Set(), ws: { readyState: 1, send: (data) => sent.push(data) } };

  withEnv({ WEEKLY_FLOW_FOLDER: undefined, PLAYLIST_FOLDER: undefined, AUTH_PASSWORD: undefined }, () => {
    websocketService.handleMessage(client, JSON.stringify({ type: "subscribe", channels: ["playlists"] }));
    assert.deepEqual(kinds(), []);
  });

  websocketService.handleMessage(client, JSON.stringify({ type: "subscribe", channels: ["weekly-flow"] }));
  const recorded = dbOps.getJSONSetting("deprecatedUsage");
  assert.deepEqual(Object.keys(recorded).sort(), ["weekly-flow-channel"]);

  websocketService.handleMessage(client, JSON.stringify({ type: "subscribe", channels: ["weekly-flow"] }));
  assert.deepEqual(dbOps.getJSONSetting("deprecatedUsage"), recorded);
  assert.equal(client.subscriptions.has("weekly-flow"), true);
});
