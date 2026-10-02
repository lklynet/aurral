import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [state, { userOps }, { default: router }] = await setupIsolatedBackend(
  "nightly-update-route", "backend/db/helpers/index.js", "backend/routes/updates.js",
);
test.after(() => cleanupIsolatedState(state));

test("nightly route authenticates, shares cached checks, and recovers after registry failure", async (t) => {
  const user = userOps.createUser("nightly-check", "unused-hash");
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers.authorization === "Bearer disposable") req.user = user;
    next();
  });
  app.use("/api/updates", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/updates/nightly`;
  const realFetch = globalThis.fetch;
  let registryCalls = 0;
  let unavailable = false;
  let version = "nightly.382+29523ef";
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  t.mock.method(globalThis, "fetch", async (target, options) => {
    if (String(target).startsWith("http://127.0.0.1:")) return realFetch(target, options);
    registryCalls++;
    if (unavailable) return new Response("", { status: 503 });
    if (String(target).includes("/token?")) return Response.json({ token: "disposable" });
    if (String(target).includes("/manifests/")) return Response.json({ config: { digest: `sha256:${"a".repeat(64)}` } });
    return Response.json({ config: { Env: [`APP_VERSION=${version}`] } });
  });
  assert.equal((await fetch(url)).status, 401);
  assert.equal(registryCalls, 0);
  const options = { headers: { Authorization: "Bearer disposable" } };
  const responses = await Promise.all([fetch(url, options), fetch(url, options)]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version, sha: "29523ef" });
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
  assert.equal(registryCalls, 3);
  version = "nightly.383+e1e5f04";
  assert.equal((await (await fetch(url, options)).json()).sha, "29523ef");
  t.mock.timers.tick(10 * 60 * 1000);
  unavailable = true;
  assert.equal((await fetch(url, options)).status, 503);
  const callsAfterFailure = registryCalls;
  assert.equal((await fetch(url, options)).status, 503);
  assert.equal(registryCalls, callsAfterFailure);
  t.mock.timers.tick(60 * 1000);
  unavailable = false;
  assert.deepEqual(await (await fetch(url, options)).json(), { version, sha: "e1e5f04" });
});
