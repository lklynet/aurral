import assert from "node:assert/strict";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import {
  CONNECT_SLUG_HOLD_MS,
  CONNECT_TRIAL_MS,
  generateEd25519KeyPair,
  parseAuthAssertion,
  parseConnectJwks,
  parseTunnelTicket,
  sha256Base64Url,
  verifyConnectToken,
} from "../../lib/connectTokens.ts";
import {
  isAllowedRedirectUri,
  setConnectEntitlement,
  startConnectTrial,
} from "../../hub/src/connect.ts";
import { deleteAccount } from "../../hub/src/handles.ts";
import { approveLink, startLink } from "../../hub/src/links.ts";
import { sha256Hex } from "../../hub/src/instances.ts";
import hub, { type Bindings } from "../../hub/src/index.ts";
import { localHub } from "../../hub/testing.ts";

const ORIGIN = "http://hub.test";
const APP_ORIGIN = "https://music.aurral.org";
const CONNECT_DOMAIN = "aurral.dev";
const RELAY_SECRET = "relay-secret-value-for-connect-tests";

const keyPair = await generateEd25519KeyPair();
const local = await localHub();
const env: Bindings = {
  ...local.env,
  HUB_ORIGIN: ORIGIN,
  APP_ORIGIN,
  CONNECT_DOMAIN,
  CONNECT_RELAY_URL: "wss://relay.aurral.dev/tunnel",
  CONNECT_SIGNING_KEY: JSON.stringify(keyPair.privateJwk),
  CONNECT_RELAY_SECRET: RELAY_SECRET,
  AUTH_SECRET: "a-test-secret-that-is-long-enough-for-better-auth",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};
afterAll(() => local.dispose());

const db = env.DB;
let githubId = 7001;

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
      return Response.json({ id: githubId, login: `user${githubId}` });
    }
    return new Response(null, { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const api = (path: string, init?: RequestInit) => hub.request(`${ORIGIN}${path}`, init, env);

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

const reset = () =>
  db.batch(
    [
      "connect_client_tokens",
      "connect_auth_codes",
      "connect_slugs",
      "connect_servers",
      "connect_entitlements",
      "listening",
      "friends",
      "publications",
      "links",
      "instances",
      "handles",
      "accounts",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );

async function createAccount(id: number, handle: string) {
  githubId = id;
  const start = await api("/account/sign-in/github");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const jar = cookieJar(start);
  const callback = await api(`/v1/auth/callback/github?code=code&state=${state}`, {
    headers: { cookie: cookieHeader(jar) },
  });
  const authed = cookieJar(callback, jar);
  const claimed = await form("/account/handle", authed, { handle });
  assert.equal(claimed.status, 302);
  const accountId = await db
    .prepare("SELECT account_id FROM handles WHERE handle = ?")
    .bind(handle)
    .first<string>("account_id");
  assert.ok(accountId);
  return { accountId, jar: authed, handle };
}

async function linkServer(
  accountId: string,
  instanceId: string,
  userName: string,
  tokenSeed: string,
  now = Date.now(),
) {
  const token = tokenSeed.padEnd(43, "a").slice(0, 43);
  const started = await startLink(
    db,
    { instanceId, userName, tokenHash: await sha256Hex(token) },
    now,
  );
  assert.ok(started);
  const approved = await approveLink(db, started.userCode.replace("-", ""), accountId, now);
  assert.equal(approved, true);
  return token;
}

const makeInstance = (n: number) => ({
  instanceId: `inst${String(n).padStart(12, "0")}`,
  secret: `sec${String(n).padStart(40, "0")}`,
});

test("Connect registration enforces trial/entitlement, server limits, reserved slugs, and 90-day holds", async () => {
  await reset();
  const owner = await createAccount(7001, "owner_one");
  const other = await createAccount(7002, "other_two");
  const inst1 = makeInstance(1);
  const inst2 = makeInstance(2);
  const inst3 = makeInstance(3);
  const inst4 = makeInstance(4);

  const ownerLink1 = await linkServer(owner.accountId, inst1.instanceId, "lee", "tok1_");

  const withoutPlan = await api("/v1/connect/servers", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerLink1}`, "content-type": "application/json" },
    body: JSON.stringify({ ...inst1, slug: "home", name: "Home Mac" }),
  });
  assert.equal(withoutPlan.status, 403);
  assert.deepEqual(await withoutPlan.json(), { error: "subscription_required" });

  for (const [badSlug, expectedStatus, expectedError] of [
    ["relay", 422, "slug_reserved"],
    ["myaurral", 422, "slug_reserved"],
    ["xn--home", 400, "slug_invalid"],
    ["-bad-", 400, "slug_invalid"],
    ["ab", 400, "slug_invalid"],
  ] as const) {
    const res = await api("/v1/connect/servers", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerLink1}`, "content-type": "application/json" },
      body: JSON.stringify({ ...inst1, slug: badSlug, name: "Home", startTrial: true }),
    });
    assert.equal(res.status, expectedStatus, `slug ${badSlug}`);
    assert.deepEqual(await res.json(), { error: expectedError });
  }

  const registered = await api("/v1/connect/servers", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerLink1}`, "content-type": "application/json" },
    body: JSON.stringify({
      ...inst1,
      slug: "Lee-Home",
      name: "Home Mac",
      lanHints: ["http://192.168.1.50:3001/", "javascript:alert(1)", "http://192.168.1.50:3001"],
      startTrial: true,
    }),
  });
  assert.equal(registered.status, 201);
  const regBody = v.parse(
    v.object({
      server: v.object({
        instanceId: v.string(),
        slug: v.string(),
        connectUrl: v.string(),
        name: v.string(),
        lanHints: v.array(v.string()),
      }),
      entitlement: v.object({
        status: v.string(),
        active: v.boolean(),
        trialAvailable: v.boolean(),
      }),
    }),
    await registered.json(),
  );
  assert.deepEqual(regBody.server, {
    instanceId: inst1.instanceId,
    slug: "lee-home",
    connectUrl: "https://lee-home.aurral.dev",
    name: "Home Mac",
    lanHints: ["http://192.168.1.50:3001"],
  });
  assert.equal(regBody.entitlement.status, "trial");
  assert.equal(regBody.entitlement.active, true);
  assert.equal(regBody.entitlement.trialAvailable, false);

  const renamed = await api(`/v1/connect/servers/${inst1.instanceId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${ownerLink1}`, "content-type": "application/json" },
    body: JSON.stringify({ slug: "studio-box", name: "Studio" }),
  });
  assert.equal(renamed.status, 200);

  const otherLink = await linkServer(other.accountId, inst2.instanceId, "sam", "tok2_");
  const heldSlug = await api("/v1/connect/servers", {
    method: "POST",
    headers: { authorization: `Bearer ${otherLink}`, "content-type": "application/json" },
    body: JSON.stringify({ ...inst2, slug: "lee-home", name: "Steal", startTrial: true }),
  });
  assert.equal(heldSlug.status, 409);
  assert.deepEqual(await heldSlug.json(), { error: "slug_taken" });

  await db
    .prepare("UPDATE connect_slugs SET released_at = ? WHERE slug = 'lee-home'")
    .bind(Date.now() - CONNECT_SLUG_HOLD_MS - 1000)
    .run();
  const afterHold = await api("/v1/connect/servers", {
    method: "POST",
    headers: { authorization: `Bearer ${otherLink}`, "content-type": "application/json" },
    body: JSON.stringify({ ...inst2, slug: "lee-home", name: "After Hold" }),
  });
  assert.equal(afterHold.status, 201);

  const ownerLink2 = await linkServer(owner.accountId, inst3.instanceId, "lee", "tok3_");
  const ownerLink3 = await linkServer(owner.accountId, inst4.instanceId, "lee", "tok4_");
  const inst5 = makeInstance(5);
  const ownerLink4 = await linkServer(owner.accountId, inst5.instanceId, "lee", "tok5_");
  assert.equal(
    (
      await api("/v1/connect/servers", {
        method: "POST",
        headers: { authorization: `Bearer ${ownerLink2}`, "content-type": "application/json" },
        body: JSON.stringify({ ...inst3, slug: "box-two", name: "Box 2" }),
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await api("/v1/connect/servers", {
        method: "POST",
        headers: { authorization: `Bearer ${ownerLink3}`, "content-type": "application/json" },
        body: JSON.stringify({ ...inst4, slug: "box-three", name: "Box 3" }),
      })
    ).status,
    201,
  );
  const fourth = await api("/v1/connect/servers", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerLink4}`, "content-type": "application/json" },
    body: JSON.stringify({ ...inst5, slug: "box-four", name: "Box 4" }),
  });
  assert.equal(fourth.status, 403);
  assert.deepEqual(await fourth.json(), { error: "server_limit_reached" });

  await deleteAccount(db, other.accountId, 1_700_000_000_000);
  const releasedRow = await db
    .prepare("SELECT instance_id, released_at FROM connect_slugs WHERE slug = 'lee-home'")
    .first<{ instance_id: string | null; released_at: number | null }>();
  assert.deepEqual(releasedRow, { instance_id: null, released_at: 1_700_000_000_000 });

  const racer = await createAccount(7003, "racer_three");
  await setConnectEntitlement(db, racer.accountId, {
    status: "active",
    maxServers: 1,
    currentPeriodEnd: Date.now() + 86_400_000,
  });
  const raceA = makeInstance(6);
  const raceB = makeInstance(7);
  const [linkA, linkB] = await Promise.all([
    linkServer(racer.accountId, raceA.instanceId, "racer", "tok6_"),
    linkServer(racer.accountId, raceB.instanceId, "racer", "tok7_"),
  ]);
  const [resA, resB] = await Promise.all([
    api("/v1/connect/servers", {
      method: "POST",
      headers: { authorization: `Bearer ${linkA}`, "content-type": "application/json" },
      body: JSON.stringify({ ...raceA, slug: "race-one", name: "Race 1" }),
    }),
    api("/v1/connect/servers", {
      method: "POST",
      headers: { authorization: `Bearer ${linkB}`, "content-type": "application/json" },
      body: JSON.stringify({ ...raceB, slug: "race-two", name: "Race 2" }),
    }),
  ]);
  assert.deepEqual([resA.status, resB.status].sort(), [201, 403]);
  const racerCount = await db
    .prepare("SELECT COUNT(*) AS count FROM connect_servers WHERE owner_account_id = ?")
    .bind(racer.accountId)
    .first<number>("count");
  assert.equal(racerCount, 1);
});

test("tunnel tickets and sign-in assertions verify via JWKS and cannot cross-replay", async () => {
  await reset();
  const owner = await createAccount(7101, "ticket_owner");
  const inst = makeInstance(11);
  const linkToken = await linkServer(owner.accountId, inst.instanceId, "lee", "ttok_");

  const unenabled = await api("/v1/connect/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inst),
  });
  assert.equal(unenabled.status, 404);

  const beforeAccount = await api("/v1/connect/account", {
    headers: { authorization: `Bearer ${linkToken}` },
  });
  assert.equal(beforeAccount.status, 200);
  const beforeAccountBody = v.parse(
    v.object({
      entitlement: v.object({
        active: v.boolean(),
        trialAvailable: v.boolean(),
        maxServers: v.number(),
      }),
      serverCount: v.number(),
    }),
    await beforeAccount.json(),
  );
  assert.equal(beforeAccountBody.entitlement.active, false);
  assert.equal(beforeAccountBody.entitlement.trialAvailable, true);
  assert.equal(beforeAccountBody.serverCount, 0);

  assert.equal(
    (
      await api("/v1/connect/servers", {
        method: "POST",
        headers: { authorization: `Bearer ${linkToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ...inst, slug: "nas-box", name: "Home NAS", startTrial: true }),
      })
    ).status,
    201,
  );

  const afterAccount = await api("/v1/connect/account", {
    headers: { authorization: `Bearer ${linkToken}` },
  });
  assert.equal(afterAccount.status, 200);
  const afterAccountBody = v.parse(
    v.object({
      entitlement: v.object({ active: v.boolean(), trialAvailable: v.boolean() }),
      serverCount: v.number(),
    }),
    await afterAccount.json(),
  );
  assert.equal(afterAccountBody.entitlement.active, true);
  assert.equal(afterAccountBody.entitlement.trialAvailable, false);
  assert.equal(afterAccountBody.serverCount, 1);

  const wrongSecret = await api("/v1/connect/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId: inst.instanceId, secret: "z".repeat(43) }),
  });
  assert.equal(wrongSecret.status, 403);

  const ticketRes = await api("/v1/connect/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...inst, lanHints: ["http://10.0.0.5:3001"] }),
  });
  assert.equal(ticketRes.status, 200);
  const ticketBody = v.parse(
    v.object({
      ticket: v.string(),
      expiresAt: v.number(),
      slug: v.string(),
      connectUrl: v.string(),
      relayUrl: v.string(),
    }),
    await ticketRes.json(),
  );
  assert.equal(ticketBody.slug, "nas-box");
  assert.equal(ticketBody.connectUrl, "https://nas-box.aurral.dev");
  assert.equal(ticketBody.relayUrl, "wss://relay.aurral.dev/tunnel");

  const jwksRes = await api("/v1/connect/keys");
  assert.equal(jwksRes.status, 200);
  const jwks = parseConnectJwks(await jwksRes.json());
  assert.ok(jwks);
  const { keys } = jwks;
  assert.equal(keys.length, 1);

  const verifiedTicket = await verifyConnectToken(ticketBody.ticket, keys, parseTunnelTicket, {
    expectedIss: ORIGIN,
    expectedAud: "aurral-relay",
  });
  assert.ok(verifiedTicket);
  assert.equal(verifiedTicket.sub, inst.instanceId);
  assert.equal(verifiedTicket.slug, "nas-box");

  const replayedAsAuth = await verifyConnectToken(ticketBody.ticket, keys, parseAuthAssertion, {
    expectedIss: ORIGIN,
  });
  assert.equal(replayedAsAuth, null);

  await setConnectEntitlement(db, owner.accountId, {
    status: "canceled",
    currentPeriodEnd: Date.now() - 1000,
  });
  const lapsedTicket = await api("/v1/connect/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inst),
  });
  assert.equal(lapsedTicket.status, 403);
  assert.deepEqual(await lapsedTicket.json(), { error: "subscription_required" });

  assert.equal(
    await startConnectTrial(db, owner.accountId, Date.now() + CONNECT_TRIAL_MS),
    "already_used",
  );
});

test("PKCE client flow, CORS, server discovery, household cap, and relay status work end to end", async () => {
  await reset();
  assert.equal(isAllowedRedirectUri("hosted", `${APP_ORIGIN}/connect/callback`, APP_ORIGIN), true);
  assert.equal(
    isAllowedRedirectUri("hosted", "https://evil.example/connect/callback", APP_ORIGIN),
    false,
  );
  assert.equal(isAllowedRedirectUri("mobile", "aurral://connect/callback", APP_ORIGIN), true);
  assert.equal(
    isAllowedRedirectUri("desktop", "http://127.0.0.1:45123/connect/callback", APP_ORIGIN),
    true,
  );
  assert.equal(
    isAllowedRedirectUri("desktop", "http://127.0.0.1:80/connect/callback", APP_ORIGIN),
    false,
  );

  const owner = await createAccount(7201, "house_owner");
  const inst = makeInstance(21);
  const ownerLink = await linkServer(owner.accountId, inst.instanceId, "lee", "hl_owner_", 1000);
  await setConnectEntitlement(db, owner.accountId, {
    status: "active",
    currentPeriodEnd: Date.now() + 86_400_000,
  });
  assert.equal(
    (
      await api("/v1/connect/servers", {
        method: "POST",
        headers: { authorization: `Bearer ${ownerLink}`, "content-type": "application/json" },
        body: JSON.stringify({ ...inst, slug: "family-box", name: "Family Server" }),
      })
    ).status,
    201,
  );

  const badStatus = await api("/v1/connect/relay/status", {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: JSON.stringify({ updates: [{ instanceId: inst.instanceId, online: true }] }),
  });
  assert.equal(badStatus.status, 401);

  const onlineRes = await api("/v1/connect/relay/status", {
    method: "POST",
    headers: { authorization: `Bearer ${RELAY_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ updates: [{ instanceId: inst.instanceId, online: true }] }),
  });
  assert.equal(onlineRes.status, 204);

  const preflight = await api("/v1/connect/servers", {
    method: "OPTIONS",
    headers: { origin: APP_ORIGIN },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), APP_ORIGIN);

  const verifier = "v".repeat(64);
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = `${APP_ORIGIN}/connect/callback`;

  const badRedirect = await api(
    `/connect/authorize?client_id=hosted&redirect_uri=https://evil.example/cb&code_challenge=${challenge}&state=abc`,
  );
  assert.equal(badRedirect.status, 400);

  const authorizeQuery = new URLSearchParams({
    client_id: "hosted",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    state: "state-123",
  });
  const confirmGet = await api(`/connect/authorize?${authorizeQuery}`, {
    headers: { cookie: cookieHeader(owner.jar) },
  });
  assert.equal(confirmGet.status, 200);
  assert.match(
    confirmGet.headers.get("content-security-policy") ?? "",
    new RegExp(`form-action 'self' ${APP_ORIGIN.replace(/\./g, "\\.")}`),
  );
  assert.match(await confirmGet.text(), /Sign in to music\.aurral\.org as @house_owner\?/);

  const approvePost = await form("/connect/authorize", owner.jar, {
    client_id: "hosted",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    state: "state-123",
  });
  assert.equal(approvePost.status, 302);
  const location = new URL(approvePost.headers.get("location") ?? "");
  assert.equal(location.origin + location.pathname, redirectUri);
  assert.equal(location.searchParams.get("state"), "state-123");
  const authCode = location.searchParams.get("code") ?? "";
  assert.ok(authCode.length === 43);

  const wrongVerifier = await api("/v1/connect/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: authCode, codeVerifier: "w".repeat(64), redirectUri }),
  });
  assert.equal(wrongVerifier.status, 400);

  const tokenRes = await api("/v1/connect/token", {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ code: authCode, codeVerifier: verifier, redirectUri }),
  });
  assert.equal(tokenRes.status, 200);
  assert.equal(tokenRes.headers.get("access-control-allow-origin"), APP_ORIGIN);
  const { token: clientToken } = v.parse(
    v.object({ token: v.string(), expiresAt: v.number() }),
    await tokenRes.json(),
  );

  const replayCode = await api("/v1/connect/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: authCode, codeVerifier: verifier, redirectUri }),
  });
  assert.equal(replayCode.status, 400);

  const discovered = await api("/v1/connect/servers", {
    headers: { authorization: `Bearer ${clientToken}` },
  });
  assert.equal(discovered.status, 200);
  const discoveredBody = v.parse(
    v.object({
      account: v.object({ id: v.string(), handle: v.nullable(v.string()) }),
      servers: v.array(
        v.object({
          instanceId: v.string(),
          name: v.string(),
          slug: v.string(),
          connectUrl: v.string(),
          online: v.boolean(),
          isOwner: v.boolean(),
          localUserName: v.string(),
        }),
      ),
    }),
    await discovered.json(),
  );
  assert.equal(discoveredBody.account.handle, "house_owner");
  assert.equal(discoveredBody.servers.length, 1);
  assert.equal(discoveredBody.servers[0]?.online, true);
  assert.equal(discoveredBody.servers[0]?.isOwner, true);
  assert.equal(discoveredBody.servers[0]?.connectUrl, "https://family-box.aurral.dev");

  const assertionRes = await api("/v1/connect/assertions", {
    method: "POST",
    headers: { authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
    body: JSON.stringify({ instanceId: inst.instanceId }),
  });
  assert.equal(assertionRes.status, 200);
  const { token: assertionJwt } = v.parse(
    v.object({ token: v.string(), expiresAt: v.number(), connectUrl: v.string() }),
    await assertionRes.json(),
  );
  const jwks2 = parseConnectJwks(await (await api("/v1/connect/keys")).json());
  assert.ok(jwks2);
  const verifiedAssertion = await verifyConnectToken(assertionJwt, jwks2.keys, parseAuthAssertion, {
    expectedIss: ORIGIN,
    expectedAud: inst.instanceId,
  });
  assert.ok(verifiedAssertion);
  assert.equal(verifiedAssertion.sub, owner.accountId);
  assert.equal(verifiedAssertion.handle, "house_owner");

  const members: { accountId: string; jar: Map<string, string> }[] = [];
  for (let index = 1; index <= 10; index += 1) {
    const member = await createAccount(7300 + index, `member_${index}`);
    await linkServer(
      member.accountId,
      inst.instanceId,
      `user${index}`,
      `hl_m${index}_`,
      2000 + index,
    );
    members.push(member);
  }

  const getMemberToken = async (jar: Map<string, string>) => {
    const post = await form("/connect/authorize", jar, {
      client_id: "hosted",
      redirect_uri: redirectUri,
      code_challenge: challenge,
      state: "member-state",
    });
    const code = new URL(post.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const tok = await api("/v1/connect/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier, redirectUri }),
    });
    return v.parse(v.object({ token: v.string() }), await tok.json()).token;
  };

  const ninthMemberToken = await getMemberToken(members[8]!.jar);
  const ninthAssertion = await api("/v1/connect/assertions", {
    method: "POST",
    headers: { authorization: `Bearer ${ninthMemberToken}`, "content-type": "application/json" },
    body: JSON.stringify({ instanceId: inst.instanceId }),
  });
  assert.equal(ninthAssertion.status, 200);

  const tenthMemberToken = await getMemberToken(members[9]!.jar);
  const tenthDiscovery = await api("/v1/connect/servers", {
    headers: { authorization: `Bearer ${tenthMemberToken}` },
  });
  assert.deepEqual(
    v.parse(v.object({ servers: v.array(v.unknown()) }), await tenthDiscovery.json()).servers,
    [],
  );
  const tenthAssertion = await api("/v1/connect/assertions", {
    method: "POST",
    headers: { authorization: `Bearer ${tenthMemberToken}`, "content-type": "application/json" },
    body: JSON.stringify({ instanceId: inst.instanceId }),
  });
  assert.equal(tenthAssertion.status, 403);
  assert.deepEqual(await tenthAssertion.json(), { error: "server_user_limit_reached" });

  assert.equal(
    (
      await api("/v1/connect/sign-out", {
        method: "POST",
        headers: { authorization: `Bearer ${clientToken}` },
      })
    ).status,
    204,
  );
  assert.equal(
    (await api("/v1/connect/servers", { headers: { authorization: `Bearer ${clientToken}` } }))
      .status,
    401,
  );
});
