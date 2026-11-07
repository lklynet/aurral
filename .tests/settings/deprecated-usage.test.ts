import assert from "node:assert/strict";
import { test, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [isolatedState, { listConfigDeprecations }] = await setupIsolatedBackend(
  "deprecated-usage",
  () => import("../../backend/services/deprecatedUsage.ts"),
);

const kinds = () => listConfigDeprecations().sort();

function withEnv(values: Record<string, string | undefined>, run: () => void) {
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
      LIBRARY_FOLDER: undefined,
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
      LIBRARY_FOLDER: "/data/library",
      DOWNLOAD_FOLDER: "/data/old-downloads",
      WEEKLY_FLOW_FOLDER: undefined,
      PLAYLIST_FOLDER: undefined,
      AUTH_PASSWORD: undefined,
    },
    () => assert.deepEqual(kinds(), []),
  );
});
