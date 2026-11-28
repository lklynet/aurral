import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import { deleteAccount } from "../../hub/src/handles.ts";
import hub, { type Bindings } from "../../hub/src/index.ts";
import { localHub, missingAuthSchema } from "../../hub/testing.ts";

const ORIGIN = "http://hub.test";
const RESEND_API = "https://resend.api.test";
const local = await localHub();
const env: Bindings = {
  ...local.env,
  HUB_ORIGIN: ORIGIN,
  APP_ORIGIN: "https://music.aurral.org",
  AUTH_SECRET: "a-test-secret-that-is-long-enough-for-better-auth",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
  RESEND_API_KEY: "re_test_magic_link_key",
  RESEND_API_ORIGIN: RESEND_API,
  EMAIL_FROM: "Aurral <noreply@aurral.org>",
};
afterAll(() => local.dispose());

const db = env.DB;

type SentEmail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
};

let sentEmails: SentEmail[] = [];
let resendResponse: () => Response = () => Response.json({ id: "email_123" });

beforeEach(() => {
  sentEmails = [];
  resendResponse = () => Response.json({ id: "email_123" });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === RESEND_API && url.pathname === "/emails") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer re_test_magic_link_key");
      const raw = typeof init?.body === "string" ? init.body : "{}";
      sentEmails.push(JSON.parse(raw) as SentEmail);
      return resendResponse();
    }
    return new Response(null, { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const api = (path: string, init?: RequestInit, customEnv = env) =>
  hub.request(`${ORIGIN}${path}`, init, customEnv);

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

const form = (
  path: string,
  fields: Record<string, string>,
  opts: { jar?: Map<string, string>; headers?: Record<string, string>; customEnv?: Bindings } = {},
) =>
  api(
    path,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        ...(opts.jar && { cookie: cookieHeader(opts.jar) }),
        ...opts.headers,
      },
      body: new URLSearchParams(fields),
    },
    opts.customEnv ?? env,
  );

const reset = () =>
  db.batch(
    [
      "verifications",
      "sessions",
      "identities",
      "connect_client_tokens",
      "connect_auth_codes",
      "connect_slugs",
      "connect_servers",
      "connect_entitlements",
      "links",
      "handles",
      "accounts",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );

function extractVerifyUrl(text: string): URL {
  const match = /https?:\/\/[^\s]+/.exec(text);
  assert.ok(match, `expected verify link in email text: ${text}`);
  return new URL(match[0]);
}

test("magicLink plugin requires no extra migrations and disables direct /v1/auth magic-link endpoints", async () => {
  assert.deepEqual(await missingAuthSchema(env), []);

  const directSend = await api("/v1/auth/sign-in/magic-link", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com" }),
  });
  assert.equal(directSend.status, 404);

  const directVerify = await api("/v1/auth/magic-link/verify?token=abcdefghijklmnop");
  assert.equal(directVerify.status, 404);

  const withoutKey = { ...env, RESEND_API_KEY: undefined };
  const hiddenPage = await api("/account", {}, withoutKey);
  assert.doesNotMatch(await hiddenPage.text(), /Continue with email/);
  const disabledPost = await form(
    "/account/sign-in/email",
    { email: "alice@example.com" },
    { customEnv: withoutKey },
  );
  assert.equal(disabledPost.status, 404);
});

test("email magic-link sign-in hashes tokens, resists GET prefetch, creates an email account, preserves Connect next, and blocks replays", async () => {
  await reset();

  const signInHtml = await (await api("/account")).text();
  assert.match(signInHtml, /Continue with email/);
  assert.match(signInHtml, /Continue with GitHub/);

  for (const badEmail of [
    "not-an-email",
    "github-4242@users.aurral.org",
    "foo@sub.users.aurral.org",
  ]) {
    const res = await form("/account/sign-in/email", { email: badEmail });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/account?error=email_invalid");
  }
  assert.equal(sentEmails.length, 0);

  const connectNext =
    "/connect/authorize?client_id=hosted&redirect_uri=https%3A%2F%2Fmusic.aurral.org%2Fconnect%2Fcallback&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&state=state123";
  const sent = await form("/account/sign-in/email", {
    email: "  Alice@Example.COM ",
    next: connectNext,
  });
  assert.equal(sent.status, 200);
  const sentHtml = await sent.text();
  assert.match(sentHtml, /We sent a sign-in link to alice@example\.com/);
  assert.match(sentHtml, /Continue to Aurral Connect/);
  assert.doesNotMatch(sentHtml, /Use a different method/);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0]?.from, "Aurral <noreply@aurral.org>");
  assert.deepEqual(sentEmails[0]?.to, ["alice@example.com"]);

  const verifyUrl = extractVerifyUrl(sentEmails[0]?.text ?? "");
  assert.equal(verifyUrl.pathname, "/account/sign-in/email/verify");
  const token = verifyUrl.searchParams.get("token");
  assert.ok(token);
  assert.equal(verifyUrl.searchParams.get("hosted"), "1");
  assert.equal(verifyUrl.searchParams.get("next"), null);

  const storedVerifications = await db
    .prepare("SELECT identifier FROM verifications")
    .all<{ identifier: string }>();
  assert.equal(storedVerifications.results.length, 1);
  assert.ok(!storedVerifications.results[0]?.identifier.includes(token));

  const prefetch1 = await api(`${verifyUrl.pathname}${verifyUrl.search}`);
  assert.equal(prefetch1.status, 200);
  assert.equal(prefetch1.headers.get("referrer-policy"), "no-referrer");
  const prefetchHtml = await prefetch1.text();
  assert.match(prefetchHtml, /Select continue to finish signing in/);

  const prefetch2 = await api(`${verifyUrl.pathname}${verifyUrl.search}`);
  assert.equal(prefetch2.status, 200);

  const verified = await form("/account/sign-in/email/verify", {
    token,
    hosted: "1",
  });
  assert.equal(verified.status, 200);
  assert.match(await verified.text(), /Return to your original tab/);
  const jar = cookieJar(verified);
  assert.ok(jar.size > 0);

  const replay = await form("/account/sign-in/email/verify", {
    token,
    hosted: "1",
  });
  assert.equal(replay.status, 303);
  assert.match(replay.headers.get("location") ?? "", /error=magic_link/);

  const resumeOriginalTab = await api(connectNext, {
    headers: { cookie: cookieHeader(jar) },
  });
  assert.equal(resumeOriginalTab.status, 200);
  assert.match(await resumeOriginalTab.text(), /Pick a handle/);

  const claimed = await form(
    "/account/handle",
    { handle: "alice_mail", next: connectNext },
    { jar },
  );
  assert.equal(claimed.status, 302);
  assert.equal(claimed.headers.get("location"), connectNext);

  const desktopNext =
    "/connect/authorize?client_id=desktop&redirect_uri=aurral%3A%2F%2Fconnect%2Fcallback&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&state=state456";
  sentEmails = [];
  const desktopSent = await form("/account/sign-in/email", {
    email: "alice@example.com",
    next: desktopNext,
  });
  assert.equal(desktopSent.status, 200);
  const desktopVerifyUrl = extractVerifyUrl(sentEmails[0]?.text ?? "");
  assert.equal(desktopVerifyUrl.searchParams.get("next"), desktopNext);
  assert.equal(desktopVerifyUrl.searchParams.get("hosted"), null);
  const desktopVerified = await form("/account/sign-in/email/verify", {
    token: desktopVerifyUrl.searchParams.get("token") ?? "",
    next: desktopNext,
  });
  assert.equal(desktopVerified.status, 303);
  assert.equal(desktopVerified.headers.get("location"), desktopNext);

  const accountPageRes = await api("/account", { headers: { cookie: cookieHeader(jar) } });
  assert.equal(accountPageRes.status, 200);
  assert.match(await accountPageRes.text(), /Signed in as alice@example\.com/);

  const storedAccount = await db
    .prepare("SELECT id, name, email, email_verified, image FROM accounts WHERE email = ?")
    .bind("alice@example.com")
    .first<{
      id: string;
      name: string;
      email: string;
      email_verified: number;
      image: string | null;
    }>();
  assert.ok(storedAccount);
  assert.equal(storedAccount.name, "");
  assert.equal(storedAccount.email_verified, 1);
  assert.equal(storedAccount.image, null);

  const session = await db
    .prepare("SELECT user_agent, ip_address FROM sessions WHERE account_id = ?")
    .bind(storedAccount.id)
    .first<{ user_agent: string | null; ip_address: string | null }>();
  assert.ok(session);
  assert.ok(!session.user_agent && !session.ip_address);

  sentEmails = [];
  const preDeleteLink = await form("/account/sign-in/email", { email: "alice@example.com" });
  assert.equal(preDeleteLink.status, 200);
  const preDeleteToken = extractVerifyUrl(sentEmails[0]?.text ?? "").searchParams.get("token");
  assert.ok(preDeleteToken);

  await deleteAccount(db, storedAccount.id);
  const remaining = await db
    .prepare("SELECT id FROM accounts WHERE email = ?")
    .bind("alice@example.com")
    .first("id");
  assert.equal(remaining, null);

  const remainingVerifications = await db
    .prepare("SELECT id FROM verifications")
    .all<{ id: string }>();
  assert.equal(remainingVerifications.results.length, 0);

  const postDeleteVerify = await form("/account/sign-in/email/verify", {
    token: preDeleteToken,
  });
  assert.equal(postDeleteVerify.status, 303);
  assert.equal(postDeleteVerify.headers.get("location"), "/account?error=magic_link");
  assert.equal(
    await db
      .prepare("SELECT id FROM accounts WHERE email = ?")
      .bind("alice@example.com")
      .first("id"),
    null,
  );
});

test("email magic-link sign-in handles Resend failures and rate limits", async () => {
  await reset();

  resendResponse = () => new Response("rate limited", { status: 500 });
  const failed = await form("/account/sign-in/email", { email: "bob@example.com" });
  assert.equal(failed.status, 303);
  assert.equal(failed.headers.get("location"), "/account?error=email_failed");

  const deniedLimiter = {
    limit: async () => ({ success: false }),
  };
  sentEmails = [];
  const throttled = await form(
    "/account/sign-in/email",
    { email: "bob@example.com" },
    { customEnv: { ...env, EMAIL_LIMITER: deniedLimiter } },
  );
  assert.equal(throttled.status, 303);
  assert.equal(throttled.headers.get("location"), "/account?error=email_busy");
  assert.equal(sentEmails.length, 0);
});
