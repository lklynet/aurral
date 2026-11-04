import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, plex] = await setupIsolatedBackend(
  "plex",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/plex.ts"),
);

const originalFetch = globalThis.fetch;
const server = { url: "http://plex.test", token: "owner-token", sendPlaylists: true };
const plexTvIds: Record<string, number> = {
  "owner-token": 100,
  "friend-token": 7,
  "stranger-token": 9,
};

function fakePlex() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const token = new Headers(init?.headers).get("x-plex-token") ?? "";
    if (url.href === "https://plex.tv/api/v2/user")
      return Response.json({ id: plexTvIds[token], username: token.replace("-token", "") });
    if (url.pathname === "/accounts")
      return Response.json({ MediaContainer: { Account: [{ id: 1 }, { id: 7 }] } });
    if (url.href === "https://plex.tv/api/v2/pins?strong=true")
      return Response.json({ id: 55, code: "abc" });
    if (url.href === "https://plex.tv/api/v2/pins/55?code=abc")
      return Response.json({ authToken: null });
    return new Response(null, { status: 404 });
  };
}

beforeEach(() => {
  resetDatabase(db);
  fakePlex();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

test("a Plex sign-in maps the owner to account 1 and others to their plex.tv ID", async () => {
  assert.deepEqual(await plex.plexHistoryAccount(server, "owner-token"), {
    username: "owner",
    accountId: "1",
  });
  assert.deepEqual(await plex.plexHistoryAccount(server, "friend-token"), {
    username: "friend",
    accountId: "7",
  });
  await assert.rejects(
    plex.plexHistoryAccount(server, "stranger-token"),
    /stranger doesn't have access to this Plex server/,
  );
});

test("only the user who started a Plex sign-in can finish it", async () => {
  const { id } = await plex.startPlexSignIn(1);

  await assert.rejects(plex.finishPlexSignIn(2, id), /expired/);
  assert.equal(await plex.finishPlexSignIn(1, id), null);
});

test("connecting the server needs the owner's token", async () => {
  globalThis.fetch = async () => new Response(null, { status: 401 });

  await assert.rejects(
    plex.connectPlexServer("http://plex.test", "friend-token"),
    /Sign in with the Plex account that owns this server/,
  );
  assert.equal(plex.getPlexServer(), null);
});
