import { requireFixture } from "../playlists/fixtures.ts";
import { test, beforeAll, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { userOps, dbOps }, { getApiKey }, { createSession }] =
  await setupIsolatedBackend(
    "lastfm-link-api-key",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/middleware/auth.ts"),
    () => import("../../backend/config/session-helpers.ts"),
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
let apiKey = "";
let sessionToken = "";
let userId: number | null = null;

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {
      lastfm: { apiKey: "test-lastfm-key", apiSecret: "test-lastfm-secret" },
    },
    onboardingComplete: true,
  });
  const user = userOps.createUser("lastfm-user", "test-password-hash", "user");
  assert.ok(user != null);
  userId = Number(user.id);
  apiKey = getApiKey();
  sessionToken = createSession(userId).token;
  server = await startServerProcess();
});

afterAll(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("user-owned mutations require a real user identity", async () => {
  const apiKeyResponse = await fetch(`http://127.0.0.1:${server.port}/api/scrobbling/lastfm/link`, {
    headers: { "X-Api-Key": apiKey },
  });
  const apiKeyPayload = await apiKeyResponse.json();

  assert.equal(apiKeyResponse.status, 403);
  assert.deepEqual(apiKeyPayload, {
    error: "User account required",
    message: "Authenticate as a user account before using this endpoint.",
  });
  assert.equal(
    requireFixture(
      db
        .prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM lastfm_link_states")
        .get(),
    ).count,
    0,
  );

  for (const [method, path, body] of [
    ["POST", "/api/play-events", { trackId: "track-1", title: "Track", artist: "Artist" }],
    ["POST", "/api/library/favorites", { ids: ["artist:missing"], starred: true }],
    ["PUT", "/api/scrobbling/listenbrainz/link", {}],
    ["PUT", "/api/scrobbling/koito/link", {}],
  ] satisfies [method: string, path: string, body: object][]) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, 403, `${path}: ${JSON.stringify(payload)}`);
    assert.deepEqual(payload, {
      error: "User account required",
      message: "Authenticate as a user account before using this endpoint.",
    });
  }

  const sessionResponse = await fetch(
    `http://127.0.0.1:${server.port}/api/scrobbling/lastfm/link`,
    { headers: { Authorization: `Bearer ${sessionToken}` } },
  );
  const sessionPayload = await sessionResponse.json();

  assert.equal(sessionResponse.status, 200, JSON.stringify(sessionPayload));
  assert.equal(sessionPayload.configured, true);
  assert.equal(sessionPayload.connected, false);
  assert.match(sessionPayload.authorizeUrl, /^https:\/\/www\.last\.fm\/api\/auth\//);
  assert.equal(
    requireFixture(
      db
        .prepare<
          unknown[],
          { user_id: import("../../backend/db/rows.ts").LastfmLinkStatesRow["user_id"] }
        >("SELECT user_id FROM lastfm_link_states")
        .get(),
    ).user_id,
    userId,
  );
});
