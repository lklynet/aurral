import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { signedInAs, listen } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { userOps }, { api }, { scrobbleConnectionStore }] =
  await setupIsolatedBackend(
    "koito-link",
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/routes/api.ts"),
    () => import("../../backend/services/scrobbleConnectionStore.ts"),
  );

const servers: Awaited<ReturnType<typeof listen>>[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await cleanupIsolatedState(isolatedState);
});

const fakeKoito = async (apiKey: string) => {
  const server = await listen({
    fetch: (request: Request) => {
      const valid =
        new URL(request.url).pathname === "/apis/listenbrainz/1/validate-token" &&
        request.headers.get("authorization") === `Token ${apiKey}`;
      return Response.json({ valid }, { status: valid ? 200 : 401 });
    },
  });
  servers.push(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
};

const regularUser = async (name: string) => {
  const user = userOps.createUser(name, "hash", "user");
  assert.ok(user);
  const url = await fakeKoito(`${name}-key`);
  const link = (token: string) =>
    signedInAs(testUser(user.id))
      .route("/", api)
      .request("/scrobbling/koito/link", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, token }),
      });
  return { id: user.id, url, link };
};

test("each regular user scrobbles to their own Koito with their own key", async () => {
  const alice = await regularUser("alice");
  const bob = await regularUser("bob");

  assert.equal((await alice.link("bob-key")).status, 400);
  assert.equal((await alice.link("alice-key")).status, 200);
  assert.equal((await bob.link("bob-key")).status, 200);

  for (const [user, token] of [
    [alice, "alice-key"],
    [bob, "bob-key"],
  ] as const) {
    const connection = scrobbleConnectionStore.getConnection(user.id, "koito");
    assert.equal(connection?.token, token);
    assert.equal(connection?.baseUrl, user.url);
  }
});
