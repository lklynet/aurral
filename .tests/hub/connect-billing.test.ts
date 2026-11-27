import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import { generateEd25519KeyPair } from "../../lib/connectTokens.ts";
import {
  getConnectBillingSummary,
  getEntitlement,
  registerConnectServer,
  startConnectTrial,
} from "../../hub/src/connect.ts";
import { deleteAccount } from "../../hub/src/handles.ts";
import { authorizeInstance, sha256Hex } from "../../hub/src/instances.ts";
import { approveLink, startLink } from "../../hub/src/links.ts";
import hub, { type Bindings } from "../../hub/src/index.ts";
import { localHub } from "../../hub/testing.ts";

const ORIGIN = "http://hub.test";
const POLAR_API = "https://polar.api.test";
const WEBHOOK_RAW_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const WEBHOOK_SECRET = `whsec_${WEBHOOK_RAW_KEY.toString("base64")}`;
const MONTHLY_PRODUCT = "prod_monthly_connect";
const YEARLY_PRODUCT = "prod_yearly_connect";

const keyPair = await generateEd25519KeyPair();
const local = await localHub();
const env: Bindings = {
  ...local.env,
  HUB_ORIGIN: ORIGIN,
  APP_ORIGIN: "https://music.aurral.org",
  CONNECT_DOMAIN: "aurral.dev",
  CONNECT_RELAY_URL: "wss://relay.aurral.dev/tunnel",
  CONNECT_SIGNING_KEY: JSON.stringify(keyPair.privateJwk),
  CONNECT_RELAY_SECRET: "relay-secret-value-for-billing-tests",
  POLAR_API_ORIGIN: POLAR_API,
  POLAR_ACCESS_TOKEN: "polar_oat_test_token",
  POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
  POLAR_PRODUCT_MONTHLY_ID: MONTHLY_PRODUCT,
  POLAR_PRODUCT_YEARLY_ID: YEARLY_PRODUCT,
  POLAR_PORTAL_URL: "https://polar.sh/aurral/portal",
  AUTH_SECRET: "a-test-secret-that-is-long-enough-for-better-auth",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};
afterAll(() => local.dispose());

const db = env.DB;
let githubId = 9001;
let polarCalls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
let polarCheckoutResponse: () => Response = () =>
  Response.json({ url: "https://buy.polar.sh/checkout_test_123" });
let polarPortalResponse: () => Response = () =>
  Response.json({ customer_portal_url: "https://polar.sh/aurral/portal?token=polar_cst_123" });

beforeEach(() => {
  polarCalls = [];
  polarCheckoutResponse = () => Response.json({ url: "https://buy.polar.sh/checkout_test_123" });
  polarPortalResponse = () =>
    Response.json({ customer_portal_url: "https://polar.sh/aurral/portal?token=polar_cst_123" });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
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
    if (url.origin === POLAR_API) {
      const headers = new Headers(init?.headers);
      const rawBody = typeof init?.body === "string" ? init.body : null;
      polarCalls.push({
        url: url.pathname,
        method: init?.method ?? "GET",
        auth: headers.get("authorization"),
        body: rawBody ? JSON.parse(rawBody) : null,
      });
      if (url.pathname === "/v1/checkouts/") return polarCheckoutResponse();
      if (url.pathname === "/v1/customer-sessions/") return polarPortalResponse();
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
  jar: Map<string, string>,
  fields: Record<string, string>,
  customEnv = env,
) =>
  api(
    path,
    {
      method: "POST",
      headers: {
        cookie: cookieHeader(jar),
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    },
    customEnv,
  );

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
  return { accountId, jar: authed };
}

function standardWebhookSign(
  rawBody: string,
  webhookId: string,
  timestampSec: number,
  keyBytes: Buffer,
) {
  const sig = createHmac("sha256", keyBytes)
    .update(`${webhookId}.${timestampSec}.${rawBody}`)
    .digest("base64");
  return `v1,${sig}`;
}

async function sendSignedWebhook(
  payload: unknown,
  opts: {
    keyBytes?: Buffer;
    webhookId?: string;
    timestampSec?: number;
    signaturePrefix?: string;
    customEnv?: Bindings;
  } = {},
) {
  const rawBody = JSON.stringify(payload);
  const webhookId = opts.webhookId ?? `msg_${crypto.randomUUID()}`;
  const timestampSec = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  const sig = standardWebhookSign(
    rawBody,
    webhookId,
    timestampSec,
    opts.keyBytes ?? WEBHOOK_RAW_KEY,
  );
  return api(
    "/v1/billing/polar/webhook",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(timestampSec),
        "webhook-signature": opts.signaturePrefix ? `${opts.signaturePrefix} ${sig}` : sig,
      },
      body: rawBody,
    },
    opts.customEnv ?? env,
  );
}

test("Polar webhook verifies Standard Webhooks whsec_ base64 keys, rejects invalid/stale requests, and gates checkout on valid webhook config", async () => {
  await reset();
  const { accountId, jar } = await createAccount(9011, "sigtest");

  const missingSecretEnv = { ...env, POLAR_WEBHOOK_SECRET: undefined };
  const badSecretEnv = { ...env, POLAR_WEBHOOK_SECRET: "polar_whs_not_standard_whsec" };
  const missingProductsEnv = {
    ...env,
    POLAR_PRODUCT_MONTHLY_ID: undefined,
    POLAR_PRODUCT_YEARLY_ID: undefined,
  };

  const unconfigured = await sendSignedWebhook(
    { type: "order.created", data: {} },
    { customEnv: missingSecretEnv },
  );
  assert.equal(unconfigured.status, 503);

  const invalidConfig = await sendSignedWebhook(
    { type: "order.created", data: {} },
    { customEnv: badSecretEnv },
  );
  assert.equal(invalidConfig.status, 503);

  const noProductsWebhook = await sendSignedWebhook(
    { type: "order.created", data: {} },
    { customEnv: missingProductsEnv },
  );
  assert.equal(noProductsWebhook.status, 503);

  const pageWithoutWebhook = await api(
    "/account",
    { headers: { cookie: cookieHeader(jar) } },
    missingSecretEnv,
  );
  assert.doesNotMatch(await pageWithoutWebhook.text(), /Subscribe · \$5\/mo/);

  const checkoutWithoutWebhook = await form(
    "/account/connect/checkout",
    jar,
    { plan: "monthly" },
    missingSecretEnv,
  );
  assert.equal(checkoutWithoutWebhook.status, 303);
  assert.equal(
    checkoutWithoutWebhook.headers.get("location"),
    "/account?billing_error=unconfigured",
  );
  assert.equal(polarCalls.length, 0);

  const missingHeaders = await api("/v1/billing/polar/webhook", {
    method: "POST",
    body: "{}",
  });
  assert.equal(missingHeaders.status, 401);

  const utf8SignedInsteadOfBase64Decoded = await sendSignedWebhook(
    { type: "order.created", data: {} },
    { keyBytes: Buffer.from(WEBHOOK_SECRET, "utf8") },
  );
  assert.equal(utf8SignedInsteadOfBase64Decoded.status, 401);

  const wrongKey = await sendSignedWebhook(
    { type: "order.created", data: {} },
    { keyBytes: Buffer.from("fedcba9876543210fedcba9876543210", "utf8") },
  );
  assert.equal(wrongKey.status, 401);

  const staleTimestamp = await sendSignedWebhook(
    { type: "order.created", data: {} },
    { timestampSec: Math.floor(Date.now() / 1000) - 600 },
  );
  assert.equal(staleTimestamp.status, 401);

  const rotated = await sendSignedWebhook(
    { type: "order.created", data: { id: "ord_1" } },
    { signaturePrefix: "v1,invalidbase64sig==" },
  );
  assert.equal(rotated.status, 200);
  assert.deepEqual(await rotated.json(), { ok: true, ignored: true });

  const wrongProduct = await sendSignedWebhook({
    type: "subscription.active",
    data: {
      id: "sub_other",
      status: "active",
      product_id: "prod_unrelated",
      customer: { id: "cust_1", external_id: accountId },
      current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  assert.equal(wrongProduct.status, 200);
  assert.deepEqual(await wrongProduct.json(), { ok: true, applied: false });
  assert.equal((await getEntitlement(db, accountId)).active, false);
});

test("Polar subscription webhooks transition trial -> active -> canceling -> uncanceled -> past_due -> revoked, handle stale events, and verify delete warning", async () => {
  await reset();
  const { accountId, jar } = await createAccount(9012, "lifecycle");

  const instanceId = "instBilling12345";
  const secret = "B".repeat(43);
  assert.equal(await authorizeInstance(db, instanceId, secret), true);
  const tokenHash = await sha256Hex("A".repeat(43));
  const started = await startLink(db, { instanceId, userName: "lee", tokenHash });
  assert.ok(started);
  await approveLink(db, started.userCode, accountId);

  assert.equal(await startConnectTrial(db, accountId), "started");
  const registered = await registerConnectServer(db, {
    instanceId,
    ownerAccountId: accountId,
    slug: "lee-billing",
    name: "Home Server",
    connectDomain: "aurral.dev",
  });
  assert.equal(registered.ok, true);

  const baseNow = Date.now();
  const nextMonth = new Date(baseNow + 30 * 86_400_000).toISOString();

  const incomplete = await sendSignedWebhook({
    type: "subscription.created",
    data: {
      id: "sub_incomplete",
      status: "incomplete",
      product_id: MONTHLY_PRODUCT,
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(incomplete.status, 200);
  assert.equal((await getEntitlement(db, accountId)).status, "trial");

  const polarTrial = await sendSignedWebhook({
    type: "subscription.updated",
    data: {
      id: "sub_1",
      status: "trialing",
      product_id: MONTHLY_PRODUCT,
      recurring_interval: "month",
      current_period_end: nextMonth,
      cancel_at_period_end: false,
      created_at: new Date(baseNow + 400).toISOString(),
      modified_at: new Date(baseNow + 500).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(polarTrial.status, 200);
  const pagePolarTrial = await api("/account", { headers: { cookie: cookieHeader(jar) } });
  const htmlPolarTrial = await pagePolarTrial.text();
  assert.match(htmlPolarTrial, /Manage billing/);
  assert.doesNotMatch(htmlPolarTrial, /Subscribe · \$5\/mo/);
  const checkoutDuringPolarTrial = await form("/account/connect/checkout", jar, {
    plan: "monthly",
  });
  assert.equal(checkoutDuringPolarTrial.status, 303);
  assert.equal(checkoutDuringPolarTrial.headers.get("location"), "/account");
  assert.equal(polarCalls.length, 0);
  const deletePolarTrialWarn = await api("/account/delete", {
    headers: { cookie: cookieHeader(jar) },
  });
  assert.match(
    await deletePolarTrialWarn.text(),
    /Cancel your Aurral Connect subscription in billing first/,
  );

  const active = await sendSignedWebhook({
    type: "subscription.active",
    data: {
      id: "sub_1",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      recurring_interval: "month",
      current_period_end: nextMonth,
      cancel_at_period_end: false,
      created_at: new Date(baseNow + 400).toISOString(),
      modified_at: new Date(baseNow + 1000).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(active.status, 200);
  assert.deepEqual(await active.json(), { ok: true, applied: true });

  const billingActive = await getConnectBillingSummary(db, accountId);
  assert.equal(billingActive.status, "active");
  assert.equal(billingActive.active, true);
  assert.equal(billingActive.polarCustomerId, "cust_1");
  assert.equal(billingActive.polarSubscriptionId, "sub_1");
  assert.equal(billingActive.billingInterval, "month");
  assert.equal(billingActive.cancelAtPeriodEnd, false);

  const pageActive = await api("/account", { headers: { cookie: cookieHeader(jar) } });
  assert.equal(pageActive.status, 200);
  const htmlActive = await pageActive.text();
  assert.match(htmlActive, /Active · Monthly/);
  assert.match(htmlActive, /Manage billing/);
  assert.match(htmlActive, /lee-billing\.aurral\.dev/);

  const expiredActive = await sendSignedWebhook({
    type: "subscription.updated",
    data: {
      id: "sub_1",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      recurring_interval: "month",
      current_period_end: new Date(baseNow - 10_000).toISOString(),
      cancel_at_period_end: false,
      created_at: new Date(baseNow + 400).toISOString(),
      modified_at: new Date(baseNow + 1500).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(expiredActive.status, 200);
  const pagePendingRenewal = await api("/account", { headers: { cookie: cookieHeader(jar) } });
  const htmlPendingRenewal = await pagePendingRenewal.text();
  assert.match(htmlPendingRenewal, /Renewal pending/);
  assert.match(htmlPendingRenewal, /Manage billing/);
  assert.doesNotMatch(htmlPendingRenewal, /Subscribe · \$5\/mo/);
  const checkoutDuringPendingRenewal = await form("/account/connect/checkout", jar, {
    plan: "monthly",
  });
  assert.equal(checkoutDuringPendingRenewal.status, 303);
  assert.equal(checkoutDuringPendingRenewal.headers.get("location"), "/account");
  assert.equal(polarCalls.length, 0);
  const deletePendingRenewalWarn = await api("/account/delete", {
    headers: { cookie: cookieHeader(jar) },
  });
  assert.match(
    await deletePendingRenewalWarn.text(),
    /Cancel your Aurral Connect subscription in billing first/,
  );

  const canceled = await sendSignedWebhook({
    type: "subscription.canceled",
    data: {
      id: "sub_1",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      recurring_interval: "month",
      current_period_end: nextMonth,
      cancel_at_period_end: true,
      modified_at: new Date(baseNow + 2000).toISOString(),
      customer: { id: "cust_1" },
    },
  });
  assert.equal(canceled.status, 200);
  assert.deepEqual(await canceled.json(), { ok: true, applied: true });
  const afterCancel = await getConnectBillingSummary(db, accountId);
  assert.equal(afterCancel.status, "active");
  assert.equal(afterCancel.active, true);
  assert.equal(afterCancel.cancelAtPeriodEnd, true);

  const deleteAfterCancel = await api("/account/delete", {
    headers: { cookie: cookieHeader(jar) },
  });
  assert.doesNotMatch(await deleteAfterCancel.text(), /Cancel your Aurral Connect subscription/);

  const ticketStillValid = await api("/v1/connect/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId, secret }),
  });
  assert.equal(ticketStillValid.status, 200);

  const stale = await sendSignedWebhook({
    type: "subscription.updated",
    data: {
      id: "sub_1",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      current_period_end: nextMonth,
      cancel_at_period_end: false,
      modified_at: new Date(baseNow + 500).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), { ok: true, applied: false });
  assert.equal((await getConnectBillingSummary(db, accountId)).cancelAtPeriodEnd, true);

  const expiredCanceled = await sendSignedWebhook({
    type: "subscription.updated",
    data: {
      id: "sub_1",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      recurring_interval: "month",
      current_period_end: new Date(baseNow - 10_000).toISOString(),
      cancel_at_period_end: true,
      created_at: new Date(baseNow + 400).toISOString(),
      modified_at: new Date(baseNow + 2500).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(expiredCanceled.status, 200);
  const pageExpiredCanceled = await api("/account", { headers: { cookie: cookieHeader(jar) } });
  const htmlExpiredCanceled = await pageExpiredCanceled.text();
  assert.match(htmlExpiredCanceled, /Subscription ending/);
  assert.match(htmlExpiredCanceled, /Ended /);
  assert.doesNotMatch(htmlExpiredCanceled, /Active · Monthly/);
  assert.doesNotMatch(htmlExpiredCanceled, /Renewal pending/);

  const uncanceled = await sendSignedWebhook({
    type: "subscription.uncanceled",
    data: {
      id: "sub_1",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      current_period_end: nextMonth,
      cancel_at_period_end: false,
      modified_at: new Date(baseNow + 3000).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(uncanceled.status, 200);
  assert.equal((await getConnectBillingSummary(db, accountId)).cancelAtPeriodEnd, false);

  const pastDue = await sendSignedWebhook({
    type: "subscription.past_due",
    data: {
      id: "sub_1",
      status: "past_due",
      product_id: MONTHLY_PRODUCT,
      current_period_end: nextMonth,
      modified_at: new Date(baseNow + 4000).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(pastDue.status, 200);
  assert.deepEqual(await pastDue.json(), { ok: true, applied: true });
  const pagePastDue = await api("/account", { headers: { cookie: cookieHeader(jar) } });
  assert.match(await pagePastDue.text(), /Payment past due/);

  const sub2 = await sendSignedWebhook({
    type: "subscription.canceled",
    data: {
      id: "sub_2",
      status: "active",
      product_id: YEARLY_PRODUCT,
      recurring_interval: "year",
      current_period_end: new Date(baseNow + 365 * 86_400_000).toISOString(),
      cancel_at_period_end: true,
      created_at: new Date(baseNow + 4900).toISOString(),
      modified_at: new Date(baseNow + 5000).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(sub2.status, 200);
  assert.deepEqual(await sub2.json(), { ok: true, applied: true });
  const afterSub2 = await getConnectBillingSummary(db, accountId);
  assert.equal(afterSub2.polarSubscriptionId, "sub_2");
  assert.equal(afterSub2.status, "active");
  assert.equal(afterSub2.cancelAtPeriodEnd, true);
  const oldPastDue = await sendSignedWebhook({
    type: "subscription.past_due",
    data: {
      id: "sub_1",
      status: "past_due",
      product_id: MONTHLY_PRODUCT,
      created_at: new Date(baseNow + 400).toISOString(),
      modified_at: new Date(baseNow + 5500).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(oldPastDue.status, 200);
  assert.deepEqual(await oldPastDue.json(), { ok: true, applied: false });
  assert.equal((await getConnectBillingSummary(db, accountId)).polarSubscriptionId, "sub_2");
  assert.equal((await getConnectBillingSummary(db, accountId)).status, "active");

  const oldMissingCreatedAt = await sendSignedWebhook({
    type: "subscription.past_due",
    data: {
      id: "sub_1",
      status: "past_due",
      product_id: MONTHLY_PRODUCT,
      modified_at: new Date(baseNow + 5800).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(oldMissingCreatedAt.status, 200);
  assert.deepEqual(await oldMissingCreatedAt.json(), { ok: true, applied: false });
  assert.equal((await getConnectBillingSummary(db, accountId)).polarSubscriptionId, "sub_2");

  const oldRevoked = await sendSignedWebhook({
    type: "subscription.revoked",
    data: {
      id: "sub_1",
      status: "canceled",
      product_id: MONTHLY_PRODUCT,
      created_at: new Date(baseNow + 400).toISOString(),
      modified_at: new Date(baseNow + 6000).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(oldRevoked.status, 200);
  assert.deepEqual(await oldRevoked.json(), { ok: true, applied: false });
  assert.equal((await getConnectBillingSummary(db, accountId)).polarSubscriptionId, "sub_2");
  assert.equal((await getEntitlement(db, accountId)).active, true);

  const revoked = await sendSignedWebhook({
    type: "subscription.revoked",
    data: {
      id: "sub_2",
      status: "canceled",
      product_id: YEARLY_PRODUCT,
      current_period_end: new Date(baseNow + 365 * 86_400_000).toISOString(),
      modified_at: new Date(baseNow + 7000).toISOString(),
      customer: { id: "cust_1", external_id: accountId },
    },
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { ok: true, applied: true });

  const afterRevoke = await getEntitlement(db, accountId);
  assert.equal(afterRevoke.status, "canceled");
  assert.equal(afterRevoke.active, false);
  assert.equal(afterRevoke.trialAvailable, false);

  const ticketBlocked = await api("/v1/connect/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId, secret }),
  });
  assert.equal(ticketBlocked.status, 403);
  assert.deepEqual(await ticketBlocked.json(), { error: "subscription_required" });

  const pageEnded = await api("/account", { headers: { cookie: cookieHeader(jar) } });
  const htmlEnded = await pageEnded.text();
  assert.match(htmlEnded, /Subscription ended/);
  assert.match(htmlEnded, /Subscribe · \$5\/mo/);
  assert.match(htmlEnded, /Billing history/);

  const unknownAccount = await sendSignedWebhook({
    type: "subscription.active",
    data: {
      id: "sub_ghost",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      customer: { id: "cust_ghost", external_id: "missing-account-id" },
    },
  });
  assert.equal(unknownAccount.status, 200);
  assert.deepEqual(await unknownAccount.json(), { ok: true, applied: false });
});

test("Reused Polar customers by email route to metadata.account_id and protect live accounts from portal takeover", async () => {
  await reset();
  const original = await createAccount(9021, "oldacct");
  await deleteAccount(db, original.accountId);
  const recreated = await createAccount(9022, "newacct");
  const liveOwner = await createAccount(9023, "liveowner");
  const otherAccount = await createAccount(9024, "otheracct");

  const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString();

  const resub = await sendSignedWebhook({
    type: "subscription.active",
    data: {
      id: "sub_resub",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      recurring_interval: "month",
      current_period_end: nextMonth,
      metadata: { account_id: recreated.accountId },
      customer: { id: "cust_reused_deleted", external_id: original.accountId },
    },
  });
  assert.equal(resub.status, 200);
  assert.deepEqual(await resub.json(), { ok: true, applied: true });
  const resubBilling = await getConnectBillingSummary(db, recreated.accountId);
  assert.equal(resubBilling.active, true);
  assert.equal(resubBilling.polarCustomerId, null);

  const resubAccountPage = await api("/account", {
    headers: { cookie: cookieHeader(recreated.jar) },
  });
  assert.match(
    await resubAccountPage.text(),
    /href="https:\/\/polar\.sh\/aurral\/portal"[^>]*>Manage billing<\/a\s*>/,
  );

  const resubPortal = await form("/account/connect/portal", recreated.jar, {});
  assert.equal(resubPortal.status, 303);
  assert.equal(resubPortal.headers.get("location"), "https://polar.sh/aurral/portal");
  assert.equal(polarCalls.length, 0);

  const collision = await sendSignedWebhook({
    type: "subscription.active",
    data: {
      id: "sub_collision",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      recurring_interval: "month",
      current_period_end: nextMonth,
      metadata: { account_id: otherAccount.accountId },
      customer: { id: "cust_live_owner", external_id: liveOwner.accountId },
    },
  });
  assert.equal(collision.status, 200);
  assert.deepEqual(await collision.json(), { ok: true, applied: true });

  const otherBilling = await getConnectBillingSummary(db, otherAccount.accountId);
  assert.equal(otherBilling.active, true);
  assert.equal(otherBilling.polarCustomerId, null);

  const otherPortal = await form("/account/connect/portal", otherAccount.jar, {});
  assert.equal(otherPortal.status, 303);
  assert.equal(otherPortal.headers.get("location"), "https://polar.sh/aurral/portal");
  assert.equal(polarCalls.length, 0);

  const now = Date.now();
  await sendSignedWebhook({
    type: "subscription.active",
    data: {
      id: "sub_verified_first",
      status: "active",
      product_id: MONTHLY_PRODUCT,
      recurring_interval: "month",
      current_period_end: nextMonth,
      created_at: new Date(now + 1000).toISOString(),
      modified_at: new Date(now + 1000).toISOString(),
      metadata: { account_id: liveOwner.accountId },
      customer: { id: "cust_live_owner", external_id: liveOwner.accountId },
    },
  });
  assert.equal(
    (await getConnectBillingSummary(db, liveOwner.accountId)).polarCustomerId,
    "cust_live_owner",
  );

  const switchedUnverified = await sendSignedWebhook({
    type: "subscription.active",
    data: {
      id: "sub_unverified_second",
      status: "active",
      product_id: YEARLY_PRODUCT,
      recurring_interval: "year",
      current_period_end: nextMonth,
      created_at: new Date(now + 2000).toISOString(),
      modified_at: new Date(now + 2000).toISOString(),
      metadata: { account_id: liveOwner.accountId },
      customer: { id: "cust_different_unverified", external_id: otherAccount.accountId },
    },
  });
  assert.equal(switchedUnverified.status, 200);
  const afterSwitch = await getConnectBillingSummary(db, liveOwner.accountId);
  assert.equal(afterSwitch.polarSubscriptionId, "sub_unverified_second");
  assert.equal(afterSwitch.polarCustomerId, null);

  await deleteAccount(db, otherAccount.accountId);
  const deletedMetadataEvent = await sendSignedWebhook({
    type: "subscription.revoked",
    data: {
      id: "sub_collision",
      status: "canceled",
      product_id: MONTHLY_PRODUCT,
      created_at: new Date(now + 3000).toISOString(),
      modified_at: new Date(now + 3000).toISOString(),
      metadata: { account_id: otherAccount.accountId },
      customer: { id: "cust_live_owner", external_id: liveOwner.accountId },
    },
  });
  assert.equal(deletedMetadataEvent.status, 200);
  assert.deepEqual(await deletedMetadataEvent.json(), { ok: true, applied: false });
  const liveOwnerStillActive = await getConnectBillingSummary(db, liveOwner.accountId);
  assert.equal(liveOwnerStillActive.polarSubscriptionId, "sub_unverified_second");
  assert.equal(liveOwnerStillActive.status, "active");
});

test("/account checkout, customer portal, and owned server disable flows work end-to-end", async () => {
  await reset();
  const alice = await createAccount(9013, "alicebill");
  const bob = await createAccount(9014, "bobbill");

  const checkoutYearly = await form("/account/connect/checkout", alice.jar, { plan: "yearly" });
  assert.equal(checkoutYearly.status, 303);
  assert.equal(checkoutYearly.headers.get("location"), "https://buy.polar.sh/checkout_test_123");
  assert.match(
    checkoutYearly.headers.get("content-security-policy") ?? "",
    /https:\/\/buy\.polar\.sh/,
  );
  assert.equal(polarCalls.length, 1);
  assert.equal(polarCalls[0]?.url, "/v1/checkouts/");
  assert.equal(polarCalls[0]?.auth, "Bearer polar_oat_test_token");
  assert.deepEqual(polarCalls[0]?.body, {
    products: [YEARLY_PRODUCT, MONTHLY_PRODUCT],
    external_customer_id: alice.accountId,
    metadata: { account_id: alice.accountId },
    success_url: `${ORIGIN}/account?checkout=success`,
    return_url: `${ORIGIN}/account`,
    allow_discount_codes: true,
  });

  const pendingPage = await api("/account?checkout=success", {
    headers: { cookie: cookieHeader(alice.jar) },
  });
  assert.match(await pendingPage.text(), /Payment received\. Refresh in a moment/);

  polarCheckoutResponse = () => new Response("upstream failure", { status: 500 });
  const failedCheckout = await form("/account/connect/checkout", alice.jar, { plan: "monthly" });
  assert.equal(failedCheckout.status, 303);
  assert.equal(failedCheckout.headers.get("location"), "/account?billing_error=checkout");

  await sendSignedWebhook({
    type: "subscription.active",
    data: {
      id: "sub_alice",
      status: "active",
      product_id: YEARLY_PRODUCT,
      recurring_interval: "year",
      current_period_end: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      customer: { id: "cust_alice", external_id: alice.accountId },
    },
  });

  polarCalls = [];
  const duplicateCheckout = await form("/account/connect/checkout", alice.jar, { plan: "monthly" });
  assert.equal(duplicateCheckout.status, 303);
  assert.equal(duplicateCheckout.headers.get("location"), "/account");
  assert.equal(polarCalls.length, 0);

  const portal = await form("/account/connect/portal", alice.jar, {});
  assert.equal(portal.status, 303);
  assert.equal(
    portal.headers.get("location"),
    "https://polar.sh/aurral/portal?token=polar_cst_123",
  );
  assert.equal(polarCalls.length, 1);
  assert.equal(polarCalls[0]?.url, "/v1/customer-sessions/");
  assert.deepEqual(polarCalls[0]?.body, {
    customer_id: "cust_alice",
    return_url: `${ORIGIN}/account`,
  });

  const reg = await registerConnectServer(db, {
    instanceId: "inst-alice-1",
    ownerAccountId: alice.accountId,
    slug: "alice-home",
    name: "Alice Home",
    connectDomain: "aurral.dev",
  });
  assert.equal(reg.ok, true);

  const bobGet = await api("/account/connect/servers/inst-alice-1/disable", {
    headers: { cookie: cookieHeader(bob.jar) },
  });
  assert.equal(bobGet.status, 302);
  assert.equal(bobGet.headers.get("location"), "/account");

  await form("/account/connect/servers/inst-alice-1/disable", bob.jar, {});
  assert.ok(
    await db
      .prepare("SELECT instance_id FROM connect_servers WHERE instance_id = ?")
      .bind("inst-alice-1")
      .first("instance_id"),
  );

  const aliceConfirm = await api("/account/connect/servers/inst-alice-1/disable", {
    headers: { cookie: cookieHeader(alice.jar) },
  });
  assert.equal(aliceConfirm.status, 200);
  const confirmHtml = await aliceConfirm.text();
  assert.match(confirmHtml, /Disable Alice Home\?/);
  assert.match(confirmHtml, /alice-home\.aurral\.dev/);
  assert.match(confirmHtml, /up to 15 minutes/);

  const aliceDisable = await form("/account/connect/servers/inst-alice-1/disable", alice.jar, {});
  assert.equal(aliceDisable.status, 302);
  assert.equal(aliceDisable.headers.get("location"), "/account?server_disabled=1");

  const afterDisablePage = await api("/account?server_disabled=1", {
    headers: { cookie: cookieHeader(alice.jar) },
  });
  assert.match(
    await afterDisablePage.text(),
    /Connect server disabled\. An active tunnel can stay online for up to 15 minutes/,
  );

  assert.equal(
    await db
      .prepare("SELECT instance_id FROM connect_servers WHERE instance_id = ?")
      .bind("inst-alice-1")
      .first("instance_id"),
    null,
  );
  const heldSlug = await db
    .prepare("SELECT instance_id, released_at FROM connect_slugs WHERE slug = ?")
    .bind("alice-home")
    .first<{ instance_id: string | null; released_at: number | null }>();
  assert.equal(heldSlug?.instance_id, null);
  assert.ok(heldSlug?.released_at && heldSlug.released_at > 0);
});
