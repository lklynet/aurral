import test, { mock } from "node:test";
import assert from "node:assert/strict";

import axios from "../../lib/axiosFetch.js";
import { PlexClient } from "../../backend/services/plex.js";

test.afterEach(() => {
  mock.restoreAll();
});

test("getHomeUsers normalizes a JSON { users: [...] } response", async () => {
  mock.method(axios, "get", async () => ({
    data: {
      users: [
        { id: 1, uuid: "u1", title: "Kid", restricted: "1", admin: "0", guest: "0" },
        {
          id: 2,
          uuid: "u2",
          title: "Friend",
          username: "friend1",
          email: "friend@example.com",
          restricted: "0",
        },
      ],
    },
  }));
  const users = await PlexClient.getHomeUsers("admin-token", "admin-client");
  assert.equal(users.length, 2);
  assert.equal(users[0].id, 1);
  assert.equal(users[0].restricted, true);
  assert.equal(users[0].email, null);
  assert.equal(users[1].username, "friend1");
  assert.equal(users[1].restricted, false);
});

test("getHomeUsers normalizes a legacy MediaContainer.User JSON response", async () => {
  mock.method(axios, "get", async () => ({
    data: { MediaContainer: { User: [{ id: 3, uuid: "u3", title: "Solo", restricted: "1" }] } },
  }));
  const users = await PlexClient.getHomeUsers("admin-token", "admin-client");
  assert.equal(users.length, 1);
  assert.equal(users[0].id, 3);
});

test("getHomeUsers tolerates a raw XML string response", async () => {
  mock.method(axios, "get", async () => ({
    data:
      '<MediaContainer size="2">' +
      '<User id="10" uuid="uuid-10" title="Kiddo" restricted="1" admin="0" guest="0"/>' +
      '<User id="11" uuid="uuid-11" title="Guest User" username="guestacct" email="g@example.com" restricted="0"/>' +
      "</MediaContainer>",
  }));
  const users = await PlexClient.getHomeUsers("admin-token", "admin-client");
  assert.equal(users.length, 2);
  assert.equal(users[0].id, "10");
  assert.equal(users[0].title, "Kiddo");
  assert.equal(users[0].restricted, true);
  assert.equal(users[1].username, "guestacct");
  assert.equal(users[1].restricted, false);
});

test("getHomeUsers returns an empty list rather than throwing on an unrecognized shape", async () => {
  mock.method(axios, "get", async () => ({ data: { unexpected: true } }));
  const users = await PlexClient.getHomeUsers("admin-token", "admin-client");
  assert.deepEqual(users, []);
});

test("switchHomeUser succeeds on the v2 path with a JSON authToken", async () => {
  let requestedUrl = null;
  mock.method(axios, "post", async (url) => {
    requestedUrl = url;
    return { data: { authToken: "fresh-token" } };
  });
  const token = await PlexClient.switchHomeUser(42, "admin-token", "admin-client", "target-client");
  assert.equal(token, "fresh-token");
  assert.match(requestedUrl, /\/api\/v2\/home\/users\/42\/switch$/);
});

test("switchHomeUser falls back to the legacy path when v2 404s", async () => {
  let call = 0;
  mock.method(axios, "post", async (url) => {
    call += 1;
    if (call === 1) {
      assert.match(url, /\/api\/v2\//);
      const error = new Error("Not found");
      error.response = { status: 404 };
      throw error;
    }
    assert.doesNotMatch(url, /\/api\/v2\//);
    return { data: { authenticationToken: "legacy-token" } };
  });
  const token = await PlexClient.switchHomeUser(42, "admin-token", "admin-client", "target-client");
  assert.equal(token, "legacy-token");
  assert.equal(call, 2);
});

test("switchHomeUser tolerates a raw XML response", async () => {
  mock.method(axios, "post", async () => ({
    data: '<user id="42" authenticationToken="xml-token"/>',
  }));
  const token = await PlexClient.switchHomeUser(42, "admin-token", "admin-client", "target-client");
  assert.equal(token, "xml-token");
});

test("switchHomeUser propagates a non-404 error without trying the fallback path", async () => {
  let calls = 0;
  mock.method(axios, "post", async () => {
    calls += 1;
    const error = new Error("Forbidden");
    error.response = { status: 403 };
    throw error;
  });
  await assert.rejects(
    () => PlexClient.switchHomeUser(42, "admin-token", "admin-client", "target-client"),
    /Forbidden/,
  );
  assert.equal(calls, 1);
});

test("switchHomeUser sends the pin and the target user's own clientId", async () => {
  let sentParams = null;
  let sentHeaders = null;
  mock.method(axios, "post", async (_url, _data, config) => {
    sentParams = config.params;
    sentHeaders = config.headers;
    return { data: { authToken: "token-with-pin" } };
  });
  await PlexClient.switchHomeUser(42, "admin-token", "admin-client", "target-client", "1234");
  assert.equal(sentParams.pin, "1234");
  assert.equal(sentHeaders["X-Plex-Client-Identifier"], "target-client");
  assert.equal(sentHeaders["X-Plex-Token"], "admin-token");
});
