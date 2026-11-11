import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";
import { test } from "vite-plus/test";
import { AurralApi } from "../aurral.ts";
import { subsonic } from "../seed.ts";
import { local } from "../services/service.ts";
import { LISTENER, LOGIN, paths } from "../state.ts";
import { api, getJson, has, ports, until } from "./eden.ts";

const songs = v.object({
  "subsonic-response": v.looseObject({
    searchResult3: v.looseObject({ song: v.array(v.looseObject({ id: v.string() })) }),
  }),
});

// Plays one Library track to the end, as a Subsonic client reports it.
async function play(user: { username: string; password: string }) {
  const [song] = v.parse(
    songs,
    await subsonic(ports, user, "search3", [
      ["query", "Radiohead"],
      ["songCount", "1"],
    ]),
  )["subsonic-response"].searchResult3.song;
  assert.ok(song);
  await subsonic(ports, user, "scrobble", [
    ["id", song.id],
    ["submission", "true"],
  ]);
}

const outsideRequests = v.array(v.object({ host: v.string(), path: v.string(), body: v.string() }));

test("a linked listener's play reaches Last.fm and ListenBrainz", async () => {
  const listener = new AurralApi(ports);
  await listener.login(LISTENER);
  const status = v.parse(
    v.looseObject({
      lastfm: v.looseObject({ connected: v.boolean() }),
      listenbrainz: v.looseObject({ connected: v.boolean() }),
    }),
    await listener.get("/scrobbling/status"),
  );
  assert.equal(status.lastfm.connected, true);
  assert.equal(status.listenbrainz.connected, true);

  await play(LISTENER);
  await until("the play to reach both services", async () => {
    const sent = v.parse(outsideRequests, await getJson(`${local(ports.outside)}/requests`));
    return (
      sent.some((request) => request.body.includes("track.scrobble")) &&
      sent.some((request) => request.path.startsWith("/1/submit-listens"))
    );
  });
});

test.skipIf(!has("navidrome", "jellyfin"))("both media servers are history servers", async () => {
  const { servers } = v.parse(
    v.object({ servers: v.array(v.looseObject({ provider: v.string() })) }),
    await api.get("/history-servers"),
  );
  const providers = servers.map((server) => server.provider);
  assert.ok(providers.includes("navidrome"));
  assert.ok(providers.includes("jellyfin"));
});

test.skipIf(!has("plugins"))(
  "the fixture plugin passes its test and hears about a play",
  async () => {
    assert.deepEqual(await api.post("/plugins/eden-fixture/test"), { message: "Hello from Eden" });
    await play(LOGIN);
    const calls = path.join(paths.aurralData, "plugin-data", "eden-fixture", "calls.jsonl");
    await until("the plugin to receive track.played", async () =>
      readFileSync(calls, "utf8").includes('"call":"event:track.played"'),
    );
  },
);

const session = v.looseObject({
  user: v.looseObject({ username: v.string(), role: v.string() }),
});

test.skipIf(!has("sso"))("single sign-on and a proxy header both sign a person in", async () => {
  const started = await fetch(`${api.base}/api/auth/oidc/login`, { redirect: "manual" });
  const cookie = started.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  const approve = new URL(started.headers.get("location") ?? "");
  approve.pathname = "/approve";
  approve.searchParams.set("person", "ada");
  const approved = await fetch(approve, { redirect: "manual" });
  // The provider sends the browser to the app's address. The backend answers there too.
  const callback = new URL(approved.headers.get("location") ?? "");
  callback.port = String(ports.aurralApi);
  const finished = await fetch(callback, { redirect: "manual", headers: { cookie } });
  const code = new URLSearchParams(
    new URL(finished.headers.get("location") ?? "", api.base).hash.slice(1),
  ).get("code");
  const exchanged = await fetch(`${api.base}/api/auth/oidc/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ code }),
  });
  const ada = v.parse(session, await exchanged.json()).user;
  assert.deepEqual([ada.username, ada.role], ["ada", "admin"]);

  const grace = v.parse(
    session,
    await getJson(`${api.base}/api/auth/me`, {
      headers: { "remote-user": "grace", "remote-groups": "listeners" },
    }),
  ).user;
  assert.deepEqual([grace.username, grace.role], ["grace", "user"]);
});
