import assert from "node:assert/strict";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import { HANDLE_HOLD_MS, claimHandle, deleteAccount } from "../../hub/src/handles.ts";
import { sha256Hex } from "../../hub/src/instances.ts";
import { LINK_CODE_MS, approveLink, linkStatus, startLink } from "../../hub/src/links.ts";
import { authorizeShareInstance } from "../../web/functions/_shareInstances.js";
import hub, { signInProviders, type Bindings } from "../../hub/src/index.ts";
import { localHub, missingAuthSchema } from "../../hub/testing.ts";

const ORIGIN = "http://hub.test";
const local = await localHub();
const env: Bindings = {
  ...local.env,
  HUB_ORIGIN: ORIGIN,
  AUTH_SECRET: "a-test-secret-that-is-long-enough-for-better-auth",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
  DISCORD_CLIENT_ID: "discord-client",
  DISCORD_CLIENT_SECRET: "discord-secret",
};
afterAll(() => local.dispose());

const db = env.DB;
let githubId = 4242;

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "gho_secret",
        token_type: "bearer",
        scope: "read:user",
      });
    }
    if (url.href === "https://api.github.com/user") {
      return Response.json({
        id: githubId,
        login: "lee",
        name: "Real Name",
        avatar_url: "https://avatars.example/4242",
      });
    }
    return new Response(null, { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const cookieJar = (response: Response, jar = new Map<string, string>()) => {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair = ""] = cookie.split(";");
    const [name = "", value = ""] = pair.split("=");
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  return jar;
};
const cookieHeader = (jar: Map<string, string>) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

async function signInWithGitHub() {
  const start = await hub.request(`${ORIGIN}/account/sign-in/github`, {}, env);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const jar = cookieJar(start);
  const callback = await hub.request(
    `${ORIGIN}/v1/auth/callback/github?code=code&state=${state}`,
    { headers: { cookie: cookieHeader(jar) } },
    env,
  );
  assert.equal(callback.headers.get("location"), "/account");
  return cookieJar(callback, jar);
}

const rows = async () => ({
  accounts: (await db.prepare("SELECT id, name, email, image FROM accounts").all()).results,
  identities: (
    await db
      .prepare(
        "SELECT provider, provider_account_id, access_token, refresh_token, id_token, scope FROM identities",
      )
      .all()
  ).results,
  sessions: (await db.prepare("SELECT user_agent, ip_address FROM sessions").all()).results,
});

const reset = () =>
  db.batch(
    ["listening", "friends", "publications", "links", "instances", "handles", "accounts"].map(
      (table) => db.prepare(`DELETE FROM ${table}`),
    ),
  );

test("schema in the migrations matches what better-auth expects", async () => {
  assert.deepEqual(await missingAuthSchema(env), []);
});

test("signing in with GitHub keeps only the provider account ID, on every sign-in", async () => {
  await reset();
  await signInWithGitHub();
  await signInWithGitHub();
  const stored = await rows();
  assert.equal(stored.accounts.length, 1);
  assert.deepEqual(
    stored.accounts.map(({ name, email, image }) => ({ name, email, image })),
    [{ name: "", email: "github-4242@users.aurral.org", image: null }],
  );
  assert.deepEqual(stored.identities, [
    {
      provider: "github",
      provider_account_id: "4242",
      access_token: null,
      refresh_token: null,
      id_token: null,
      scope: null,
    },
  ]);
  assert.ok(stored.sessions.every((session) => !session.user_agent && !session.ip_address));

  const [deleted] = stored.accounts;
  await deleteAccount(db, String(deleted?.id));
  assert.deepEqual(await rows(), { accounts: [], identities: [], sessions: [] });
  await signInWithGitHub();
  const fresh = await rows();
  assert.equal(fresh.accounts.length, 1);
  assert.notEqual(fresh.accounts[0]?.id, deleted?.id);
});

test("a sign-up cut off before its identity was saved finishes on the next sign-in", async () => {
  await reset();
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO accounts (id, name, email, email_verified, created_at, updated_at) VALUES ('orphan', '', ?, 1, ?, ?)",
    )
    .bind("github-4242@users.aurral.org", now, now)
    .run();
  await signInWithGitHub();
  const stored = await rows();
  assert.deepEqual(
    stored.accounts.map(({ id }) => id),
    ["orphan"],
  );
  assert.equal(stored.identities.length, 1);
  assert.equal(stored.identities[0]?.access_token, null);
});

test("routes that would store provider tokens or edit the account are off", async () => {
  const jar = await signInWithGitHub();
  for (const path of ["/link-social", "/unlink-account", "/update-user"]) {
    const response = await hub.request(
      `${ORIGIN}/v1/auth${path}`,
      {
        method: "POST",
        headers: { cookie: cookieHeader(jar), origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", name: "x" }),
      },
      env,
    );
    assert.equal(response.status, 404, path);
  }
});

test("only GitHub and Discord sign in unless Eden configures its own provider", () => {
  assert.deepEqual(signInProviders(env), ["github", "discord"]);
  assert.deepEqual(signInProviders({ ...env, GITHUB_CLIENT_ID: undefined }), ["discord"]);
  assert.deepEqual(signInProviders({ ...env, EDEN_OIDC_ISSUER: "http://127.0.0.1:1" }), [
    "github",
    "discord",
    "eden",
  ]);
});

test("handles follow the rules, belong to one account, and stay held after the account is deleted", async () => {
  await reset();
  const now = new Date().toISOString();
  await db.batch(
    ["a", "b"].map((id) =>
      db
        .prepare(
          "INSERT INTO accounts (id, name, email, email_verified, created_at, updated_at) VALUES (?, '', ?, 1, ?, ?)",
        )
        .bind(id, `test-${id}@users.aurral.org`, now, now),
    ),
  );
  const cases: [string, string, string][] = [
    ["a", "ab", "invalid"],
    ["a", "has space", "invalid"],
    ["a", "admin", "reserved"],
    ["a", "aurral_fan", "reserved"],
    ["a", "@LklyNet", "reserved"],
    ["a", "lklynet_official", "reserved"],
    ["a", "@Lee_K", "claimed"],
    ["a", "second", "taken"],
    ["b", "LEE_K", "taken"],
  ];
  for (const [account, input, expected] of cases) {
    assert.equal(await claimHandle(db, account, input), expected, input);
  }
  const deletedAt = Date.now();
  await deleteAccount(db, "a", deletedAt);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM accounts").first("n")) ?? 0, 1);
  assert.equal(await claimHandle(db, "b", "lee_k", deletedAt + HANDLE_HOLD_MS - 1), "taken");
  assert.equal(await claimHandle(db, "b", "lee_k", deletedAt + HANDLE_HOLD_MS), "claimed");
});

test("visiting the account page renews a session that is close to expiring", async () => {
  await reset();
  const jar = await signInWithGitHub();
  const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("UPDATE sessions SET expires_at = ?").bind(soon).run();
  const page = await hub.request(
    `${ORIGIN}/account`,
    { headers: { cookie: cookieHeader(jar) } },
    env,
  );
  const renewed = page.headers.getSetCookie().find((cookie) => cookie.includes("session_token="));
  assert.match(renewed ?? "", /Max-Age=604800/);
});

test("account forms refuse posts from another origin", async () => {
  const jar = await signInWithGitHub();
  const post = (origin: string) =>
    hub.request(
      `${ORIGIN}/account/sign-out`,
      {
        method: "POST",
        headers: {
          cookie: cookieHeader(jar),
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
      },
      env,
    );
  assert.equal((await post("https://evil.example")).status, 403);
  assert.equal((await post(ORIGIN)).status, 302);
});

const INSTANCE = { instanceId: "inst_aaaaaaaaaaa", secret: "s".repeat(43) };
const linkToken = "t".repeat(43);

const api = (path: string, init: RequestInit = {}) => hub.request(`${ORIGIN}${path}`, init, env);
const form = (path: string, jar: Map<string, string>, fields: Record<string, string>) =>
  api(path, {
    method: "POST",
    headers: {
      cookie: cookieHeader(jar),
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
const startServerLink = async (secret = INSTANCE.secret) =>
  api("/v1/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...INSTANCE, secret, token: linkToken, userName: "lee\u0000 " }),
  });
const serverStatus = async () =>
  api("/v1/link", { headers: { authorization: `Bearer ${linkToken}` } });

test("a server links a user once a signed-in account approves its code, and either side can undo it", async () => {
  await reset();
  githubId = 4242;
  assert.equal(await authorizeShareInstance(db, INSTANCE.instanceId, INSTANCE.secret), true);
  assert.equal((await startServerLink("x".repeat(43))).status, 403);

  const started = await startServerLink();
  assert.equal(started.status, 201);
  const { userCode } = v.parse(v.object({ userCode: v.string() }), await started.json());
  assert.ok(v.is(v.object({ status: v.literal("pending") }), await (await serverStatus()).json()));

  const signedOut = await api(`/link?code=${userCode.toLowerCase()}`);
  assert.match(
    await signedOut.text(),
    new RegExp(`sign-in/github\\?code=${userCode.replace("-", "")}`),
  );

  const jar = await signInWithGitHub();
  const code = userCode.replace("-", "");
  const claimed = await form("/account/handle", jar, { handle: "lee_k", code });
  assert.equal(claimed.headers.get("location"), `/link?code=${code}`);
  const confirm = await (
    await api(`/link?code=${code}`, { headers: { cookie: cookieHeader(jar) } })
  ).text();
  assert.match(confirm, /Link Aurral user lee to @lee_k\?/);

  assert.equal((await form("/link", jar, { code })).headers.get("location"), "/account");
  assert.equal((await form("/link", jar, { code })).status, 404);
  assert.deepEqual(await (await serverStatus()).json(), { status: "linked", handle: "lee_k" });

  const linkId = await db.prepare("SELECT id FROM links").first<string>("id");
  githubId = 5151;
  const stranger = await signInWithGitHub();
  await form(`/account/unlink/${linkId}`, stranger, {});
  assert.equal((await serverStatus()).status, 200);
  await form(`/account/unlink/${linkId}`, jar, {});
  const revoked = await serverStatus();
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.text(), JSON.stringify({ error: "link_revoked" }));

  await startServerLink();
  const tokenHash = await sha256Hex(linkToken);
  const revoke = (secret: string) =>
    api("/v1/links/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...INSTANCE, secret, tokenHash }),
    });
  assert.equal((await revoke("x".repeat(43))).status, 403);
  assert.equal((await revoke(INSTANCE.secret)).status, 204);
  assert.equal((await serverStatus()).status, 401);
});

test("linked servers add friends by handle, both asking makes friends, friends see what each other plays, and either side ends it", async () => {
  await reset();
  const now = new Date().toISOString();
  const tokens = { ann: "a".repeat(43), bob: "b".repeat(43) };
  for (const [handle, token] of Object.entries(tokens)) {
    await db
      .prepare(
        "INSERT INTO accounts (id, name, email, email_verified, created_at, updated_at) VALUES (?, '', ?, 1, ?, ?)",
      )
      .bind(handle, `test-${handle}@users.aurral.org`, now, now)
      .run();
    await claimHandle(db, handle, handle);
    await db
      .prepare(
        "INSERT INTO links (id, instance_id, user_name, token_hash, account_id, linked_at) VALUES (?, 'inst', ?, ?, ?, 1)",
      )
      .bind(handle, handle, await sha256Hex(token), handle)
      .run();
  }
  const friends = (token: string, method = "GET", handle = "") =>
    api(`/v1/friends${handle && `/${handle}`}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
  const lists = async (token: string): Promise<unknown> => (await friends(token)).json();
  const rowCount = async () =>
    (await db.prepare("SELECT COUNT(*) AS n FROM friends").first("n")) ?? 0;

  assert.equal((await friends("x".repeat(43))).status, 401);
  assert.equal((await friends(tokens.ann, "PUT", "nobody")).status, 404);
  assert.equal((await friends(tokens.ann, "PUT", "ANN")).status, 422);
  assert.deepEqual(await (await friends(tokens.ann, "PUT", "Bob")).json(), { status: "sent" });
  assert.deepEqual(await lists(tokens.ann), {
    friends: [],
    incoming: [],
    outgoing: [{ handle: "bob" }],
  });
  assert.deepEqual(await lists(tokens.bob), {
    friends: [],
    incoming: [{ handle: "ann" }],
    outgoing: [],
  });

  const share = (link: string, nowPlaying: object | null, until: number, top: object, at: number) =>
    db
      .prepare(
        "INSERT INTO listening (link_id, now_playing, playing_until, top_plays, top_plays_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(link, nowPlaying && JSON.stringify(nowPlaying), until, JSON.stringify(top), at)
      .run();
  const time = Date.now();
  const top = (plays: number) => ({
    artists: [{ name: "Radiohead", plays }],
    albums: [],
    tracks: [{ title: "Nude", artist: "Radiohead", plays }],
  });
  await share(
    "bob",
    { title: "Nude", artist: "Radiohead", album: null },
    time + 60_000,
    top(3),
    time,
  );
  assert.deepEqual(await lists(tokens.ann), {
    friends: [],
    incoming: [],
    outgoing: [{ handle: "bob" }],
  });

  assert.deepEqual(await (await friends(tokens.bob, "PUT", "ann")).json(), { status: "friends" });
  await db
    .prepare(
      "INSERT INTO links (id, instance_id, user_name, token_hash, account_id, linked_at) VALUES ('bob-2', 'inst', 'bob', 'h2', 'bob', 1), ('bob-3', 'inst', 'bob', 'h3', 'bob', 1)",
    )
    .run();
  await share(
    "bob-2",
    { title: "Old", artist: "Radiohead", album: null },
    time - 1,
    {
      ...top(2),
      artists: [
        { name: "radiohead", plays: 2 },
        { name: "Björk", plays: 4 },
      ],
    },
    time,
  );
  await share("bob-3", null, 0, top(50), time - 8 * 86_400_000);
  assert.deepEqual(await lists(tokens.ann), {
    friends: [
      {
        handle: "bob",
        nowPlaying: { title: "Nude", artist: "Radiohead", album: null },
        topPlays: {
          artists: [
            { name: "Radiohead", plays: 5 },
            { name: "Björk", plays: 4 },
          ],
          albums: [],
          tracks: [{ title: "Nude", artist: "Radiohead", plays: 5 }],
        },
      },
    ],
    incoming: [],
    outgoing: [],
  });
  assert.deepEqual(await lists(tokens.bob), {
    friends: [{ handle: "ann", nowPlaying: null, topPlays: null }],
    incoming: [],
    outgoing: [],
  });

  assert.equal((await friends(tokens.bob, "DELETE", "ann")).status, 204);
  assert.equal(await rowCount(), 0);
  assert.equal((await friends(tokens.bob, "PUT", "ann")).status, 200);
  await friends(tokens.ann, "DELETE", "bob");
  assert.equal(await rowCount(), 0);

  assert.equal((await friends(tokens.bob, "PUT", "ann")).status, 200);
  assert.equal(await rowCount(), 1);
  await deleteAccount(db, "bob");
  assert.equal(await rowCount(), 0);
});

test("a linked server shares now playing and top plays, and they leave with the link", async () => {
  await reset();
  githubId = 4242;
  const jar = await signInWithGitHub();
  await startServerLink();
  const code = await db.prepare("SELECT user_code FROM links").first<string>("user_code");
  assert.ok(code);
  await form("/account/handle", jar, { handle: "lee_k", code });
  await form("/link", jar, { code });
  const share = (path: string, method: string, body?: unknown) =>
    api(`/v1/listening${path}`, {
      method,
      headers: { authorization: `Bearer ${linkToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const stored = () =>
    db
      .prepare("SELECT now_playing, playing_until, top_plays FROM listening")
      .first<{ now_playing: string | null; playing_until: number; top_plays: string | null }>();

  const before = Date.now();
  const track = { title: " Reckoner ", artist: "Radiohead", album: null, durationMs: 290_000 };
  assert.equal((await share("/now-playing", "PUT", track)).status, 204);
  const top = {
    artists: [{ name: "Radiohead", plays: 12 }],
    albums: [{ title: "In Rainbows", artist: "Radiohead", plays: 9 }],
    tracks: [{ title: "Reckoner", artist: "Radiohead", plays: 4 }],
  };
  assert.equal((await share("/top-plays", "PUT", top)).status, 204);
  const shared = await stored();
  assert.deepEqual(JSON.parse(shared?.now_playing ?? ""), {
    title: "Reckoner",
    artist: "Radiohead",
    album: null,
  });
  assert.ok(shared && shared.playing_until >= before + 290_000);
  assert.deepEqual(JSON.parse(shared?.top_plays ?? ""), top);

  const tooMany = { ...top, tracks: Array.from({ length: 11 }, () => top.tracks[0]) };
  assert.equal((await share("/top-plays", "PUT", tooMany)).status, 400);
  assert.equal((await share("", "DELETE")).status, 204);
  assert.equal(await stored(), null);

  await share("/now-playing", "PUT", track);
  const linkId = await db.prepare("SELECT id FROM links").first<string>("id");
  await form(`/account/unlink/${linkId}`, jar, {});
  assert.equal(await stored(), null);
  assert.equal((await share("/now-playing", "PUT", track)).status, 401);
});

test("a code approves one account once and only before it expires", async () => {
  await reset();
  const now = Date.now();
  const expired = now + LINK_CODE_MS;
  await db.batch(
    ["a", "b"].map((id) =>
      db
        .prepare(
          "INSERT INTO accounts (id, name, email, email_verified, created_at, updated_at) VALUES (?, '', ?, 1, ?, ?)",
        )
        .bind(
          id,
          `test-${id}@users.aurral.org`,
          new Date(now).toISOString(),
          new Date(now).toISOString(),
        ),
    ),
  );
  const link = { instanceId: INSTANCE.instanceId, userName: "lee" };
  const first = await startLink(db, { ...link, tokenHash: "aa" }, now);
  const late = await startLink(db, { ...link, tokenHash: "bb" }, now);
  const code = (started: typeof first) => started?.userCode.replace("-", "") ?? "";

  const approvals = await Promise.all(
    ["a", "b"].map((account) => approveLink(db, code(first), account, now + 1)),
  );
  assert.deepEqual(approvals.toSorted(), [false, true]);
  assert.equal(await approveLink(db, code(late), "a", expired), false);
  assert.equal(await linkStatus(db, "bb", expired), null);
});

test("a linked server publishes playlists to the shelf, and they leave with the link", async () => {
  await reset();
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO accounts (id, name, email, email_verified, created_at, updated_at) VALUES ('lee', '', 'lee@users.aurral.org', 1, ?, ?)",
      )
      .bind(now, now),
    db.prepare("INSERT INTO handles (handle, account_id) VALUES ('lee_k', 'lee')"),
    db
      .prepare(
        "INSERT INTO links (id, instance_id, user_name, token_hash, account_id, linked_at) VALUES ('link', ?, 'lee', ?, 'lee', 1)",
      )
      .bind(INSTANCE.instanceId, await sha256Hex(linkToken)),
  ]);
  const track = { title: "Song", artistName: "Band", path: "tracks/1/2", size: 9, format: "flac" };
  const send = (method: string, path: string, title: string, token = linkToken) =>
    api(path, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: title, manifest: { kind: "playlist", title, tracks: [track] } }),
    });
  const idOf = async (response: Response) =>
    v.parse(v.object({ id: v.string() }), await response.json()).id;
  const listed = v.object({
    playlists: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        handle: v.string(),
        artist: v.nullable(v.string()),
      }),
    ),
  });
  const shelf = async () => v.parse(listed, await (await api("/v1/playlists")).json()).playlists;

  assert.equal((await send("POST", "/v1/publications", "fuck this")).status, 422);
  assert.equal((await send("POST", "/v1/publications", "Late", "u".repeat(43))).status, 401);
  const ids = [];
  for (const title of ["One", "Two", "Three", "Late night"]) {
    const created = await send("POST", "/v1/publications", title);
    assert.equal(created.status, 201);
    ids.push(await idOf(created));
  }
  assert.equal(await idOf(await send("POST", "/v1/publications", "Two")), ids[1]);
  const latest = ids.at(-1) ?? "";
  assert.deepEqual(
    (await shelf()).map(({ title, handle, artist }) => `${handle}:${title}:${artist}`),
    ["lee_k:Late night:Band", "lee_k:Three:Band", "lee_k:Two:Band"],
  );

  assert.equal((await send("PUT", `/v1/publications/${latest}`, "shit list")).status, 422);
  assert.equal((await send("PUT", `/v1/publications/${latest}`, "Later night")).status, 204);
  const opened = v.parse(
    v.object({
      handle: v.string(),
      manifest: v.object({ title: v.string(), tracks: v.array(v.object({ path: v.null() })) }),
    }),
    await (await api(`/v1/playlists/${latest}`)).json(),
  );
  assert.equal(`${opened.handle}:${opened.manifest.title}`, "lee_k:Later night");

  await db.prepare("UPDATE publications SET delisted = 1 WHERE id = ?").bind(latest).run();
  assert.equal((await api(`/v1/playlists/${latest}`)).status, 404);
  assert.deepEqual(
    (await shelf()).map(({ title }) => title),
    ["Three", "Two", "One"],
  );
  assert.equal((await send("DELETE", `/v1/publications/${latest}`, "")).status, 204);
  const republished = await send("POST", "/v1/publications", "Late night");
  const refusal: unknown = await republished.json();
  assert.deepEqual(
    { status: republished.status, refusal },
    { status: 403, refusal: { error: "delisted" } },
  );

  assert.equal((await send("DELETE", `/v1/publications/${ids[0]}`, "")).status, 204);
  assert.equal((await shelf()).length, 2);
  await deleteAccount(db, "lee");
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM publications").first("n"), 0);
});
