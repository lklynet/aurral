import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps }, { api }] = await setupIsolatedBackend(
  "lastfm-callback",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/routes/api.ts"),
);

let userId = 0;

beforeAll(() => {
  resetDatabase(db);
  dbOps.updateSettings({
    onboardingComplete: true,
    integrations: { lastfm: { apiKey: "test-lastfm-key", apiSecret: "test-lastfm-secret" } },
  });
  const user = userOps.createUser("lastfm-callback-user", "test-password-hash", "user");
  assert.ok(user != null);
  userId = user.id;
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

async function linkCallback(headers: Record<string, string>) {
  const app = signedInAs(testUser(userId)).route("/", api);
  const response = await app.request("/scrobbling/lastfm/link", { headers });
  assert.equal(response.status, 200);
  const { authorizeUrl } = await response.json();
  return new URL(String(new URL(authorizeUrl).searchParams.get("cb")));
}

test("Last.fm callback uses the request host and preserves signed state", async () => {
  const callback = await linkCallback({
    host: "192.168.4.115:3009",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https",
  });

  assert.equal(callback.origin, "http://192.168.4.115:3009");
  assert.equal(callback.pathname, "/api/scrobbling/lastfm/link/callback");
  assert.match(String(callback.searchParams.get("uid")), /^[\w-]+\.[\w-]+$/);
});

test("Last.fm callback uses the configured public origin when available", async () => {
  const previous = process.env.AURRAL_PUBLIC_URL;
  process.env.AURRAL_PUBLIC_URL = "https://aurral.example.com";
  try {
    const callback = await linkCallback({ host: "attacker.example" });
    assert.equal(callback.origin, "https://aurral.example.com");
  } finally {
    if (previous === undefined) delete process.env.AURRAL_PUBLIC_URL;
    else process.env.AURRAL_PUBLIC_URL = previous;
  }
});
