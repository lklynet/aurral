import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import { HANDLE_HOLD_MS, claimHandle, deleteAccount } from "../../hub/src/handles.ts";
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
        id: 4242,
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
  db.batch([db.prepare("DELETE FROM handles"), db.prepare("DELETE FROM accounts")]);

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
