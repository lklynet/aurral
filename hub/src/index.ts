import type { D1Database, RateLimit } from "@cloudflare/workers-types/index.ts";
import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { validator } from "hono/validator";
import * as v from "valibot";
import { authFor, socialProviders } from "./auth.ts";
import {
  CONNECT_CLIENTS,
  applyPolarSubscriptionEvent,
  connectJwks,
  createConnectAuthCode,
  disableConnectServer,
  discoverConnectServers,
  exchangeConnectAuthCode,
  getConnectAccountSummary,
  getConnectBillingSummary,
  getOwnedConnectServer,
  getOwnedConnectServers,
  hasManagedPolarSubscription,
  isAllowedRedirectUri,
  issueConnectAssertion,
  issueTunnelTicket,
  registerConnectServer,
  resolveConnectClientAccount,
  revokeConnectClientToken,
  updateConnectServer,
  updateRelayStatus,
  type ConnectClientId,
} from "./connect.ts";
import { friendLists, removeFriend, requestFriend } from "./friends.ts";
import { claimHandle, deleteAccount, handleOf } from "./handles.ts";
import {
  clearListening,
  friendsBlendTracks,
  nowPlayingSchema,
  setNowPlaying,
  setTopPlays,
  sharedTopPlaysSchema,
} from "./listening.ts";
import { authorizeInstance, sha256Hex } from "./instances.ts";
import {
  accountLink,
  accountLinks,
  approveLink,
  linkStatus,
  linkedAccountId,
  linkedLinkDetails,
  normalizeCode,
  pendingLink,
  revokeLink,
  startLink,
  unlinkForAccount,
} from "./links.ts";
import {
  linkedLinkId,
  profile,
  publicPlaylist,
  publish,
  readPublication,
  shelf,
  unpublish,
  updatePublication,
} from "./publications.ts";
import {
  accountPage,
  connectAuthorizePage,
  connectErrorPage,
  deletePage,
  disableConnectServerPage,
  handlePage,
  linkCodePage,
  linkConfirmPage,
  signInPage,
  STYLE,
  unlinkPage,
  type AccountBillingError,
} from "./pages.ts";
import {
  allowedPolarProductIds,
  createPolarCheckout,
  createPolarCustomerPortal,
  decodePolarWebhookSecret,
  isPolarBillingConfigured,
  isPolarPortalConfigured,
  parsePolarWebhookEvent,
  polarConfig,
  verifyPolarWebhookSignature,
  type PolarBillingPlan,
} from "./polar.ts";

export type Bindings = {
  DB: D1Database;
  LINK_LIMITER: RateLimit;
  HUB_ORIGIN: string;
  APP_ORIGIN?: string;
  CONNECT_DOMAIN?: string;
  CONNECT_RELAY_URL?: string;
  CONNECT_SIGNING_KEY?: string;
  CONNECT_RELAY_SECRET?: string;
  POLAR_API_ORIGIN?: string;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  POLAR_PRODUCT_MONTHLY_ID?: string;
  POLAR_PRODUCT_YEARLY_ID?: string;
  POLAR_PORTAL_URL?: string;
  AUTH_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  EDEN_OIDC_ISSUER?: string;
};

type Env = { Bindings: Bindings };

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  discord: "Discord",
  eden: "Eden",
};

const CLIENT_LABELS: Record<ConnectClientId, string> = {
  hosted: "music.aurral.org",
  desktop: "Aurral Desktop",
  mobile: "Aurral",
};

export const signInProviders = (env: Bindings) => [
  ...Object.keys(socialProviders(env)),
  ...(env.EDEN_OIDC_ISSUER ? ["eden"] : []),
];

const TOKEN = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._~-]{43,128}$/));
const STATE_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const instance = { instanceId: v.string(), secret: v.string() };
const cleanLabel = v.pipe(
  v.string(),
  v.transform((name) =>
    name
      .replace(/\p{Cc}/gu, " ")
      .trim()
      .slice(0, 64),
  ),
  v.minLength(1),
);
const lanHintsField = v.optional(v.pipe(v.array(v.string()), v.maxLength(16)));
const startSchema = v.object({
  ...instance,
  token: TOKEN,
  userName: cleanLabel,
});
const revokeSchema = v.object({ ...instance, tokenHash: v.pipe(v.string(), v.hexadecimal()) });
const connectRegisterSchema = v.object({
  ...instance,
  slug: v.string(),
  name: cleanLabel,
  lanHints: lanHintsField,
  startTrial: v.optional(v.boolean()),
});
const connectUpdateSchema = v.object({
  slug: v.optional(v.string()),
  name: v.optional(cleanLabel),
  lanHints: lanHintsField,
});
const connectTicketSchema = v.object({
  ...instance,
  lanHints: lanHintsField,
});
const connectTokenSchema = v.object({
  code: TOKEN,
  codeVerifier: PKCE_VERIFIER,
  redirectUri: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});
const connectAssertionSchema = v.object({
  instanceId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});
const connectRelayStatusSchema = v.object({
  updates: v.pipe(
    v.array(v.object({ instanceId: v.string(), online: v.boolean() })),
    v.maxLength(500),
  ),
});

const connectConfig = (env: Bindings) => ({
  appOrigin: (env.APP_ORIGIN ?? "https://music.aurral.org").replace(/\/+$/, ""),
  connectDomain: (env.CONNECT_DOMAIN ?? "aurral.dev").replace(/^\.+|\.+$/g, "").toLowerCase(),
  relayUrl: env.CONNECT_RELAY_URL ?? "wss://relay.aurral.dev/tunnel",
});

async function sameSecret(left: string, right: string) {
  const [a, b] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  let difference = a.length ^ b.length;
  for (let index = 0; index < b.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

const rawBearer = (c: Context<Env>) => {
  const header = c.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
};

const CONNECT_ERRORS = {
  subscription_required: 403,
  server_already_owned: 409,
  server_limit_reached: 403,
  slug_invalid: 400,
  slug_reserved: 422,
  slug_not_allowed: 422,
  slug_taken: 409,
  not_found: 404,
  forbidden: 403,
  connect_unconfigured: 503,
  connect_not_enabled: 404,
  handle_required: 403,
  server_not_linked: 404,
  server_user_limit_reached: 403,
} as const;

const json = <Schema extends v.GenericSchema>(schema: Schema) =>
  validator("json", (value, c) => {
    const parsed = v.safeParse(schema, value);
    return parsed.success ? parsed.output : c.json({ error: "invalid_request" }, 400);
  });

const bearer = (c: Context<Env>) =>
  /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1] ?? null;

const REFUSALS = {
  too_large: [413, "share_too_large"],
  invalid: [400, "invalid_manifest"],
  title_not_allowed: [422, "title_not_allowed"],
} as const;

const linkOf = async (c: Context<Env>) => {
  const token = bearer(c);
  return token ? linkedLinkId(c.env.DB, await sha256Hex(token)) : null;
};

const linkRevoked = (c: Context<Env>) => c.json({ error: "link_revoked" }, 401);

const accountOfLink = async (c: Context<Env>) => {
  const token = bearer(c);
  return token ? linkedAccountId(c.env.DB, await sha256Hex(token)) : null;
};

const v1 = new Hono<Env>()
  .get("/health", (c) => c.json({ ok: true }))
  .on(["GET", "POST"], "/auth/*", (c) => authFor(c.env).handler(c.req.raw))
  .post("/links", json(startSchema), async (c) => {
    const body = c.req.valid("json");
    if (!(await authorizeInstance(c.env.DB, body.instanceId, body.secret))) {
      return c.json({ error: "wrong_secret" }, 403);
    }
    const started = await startLink(c.env.DB, {
      instanceId: body.instanceId,
      userName: body.userName,
      tokenHash: await sha256Hex(body.token),
    });
    return started ? c.json(started, 201) : c.json({ error: "try_again" }, 503);
  })
  .get("/link", async (c) => {
    const token = bearer(c);
    const status = token && (await linkStatus(c.env.DB, await sha256Hex(token)));
    return status ? c.json(status) : c.json({ error: "link_revoked" }, 401);
  })
  .post("/links/revoke", json(revokeSchema), async (c) => {
    const body = c.req.valid("json");
    if (!(await authorizeInstance(c.env.DB, body.instanceId, body.secret))) {
      return c.json({ error: "wrong_secret" }, 403);
    }
    await revokeLink(c.env.DB, body.instanceId, body.tokenHash.toLowerCase());
    return c.body(null, 204);
  })
  .post("/publications", async (c) => {
    const linkId = await linkOf(c);
    if (!linkId) return linkRevoked(c);
    const body = readPublication(await c.req.text());
    if (typeof body === "string") {
      const [status, error] = REFUSALS[body];
      return c.json({ error }, status);
    }
    if (!body.ref) return c.json({ error: "invalid_manifest" }, 400);
    const published = await publish(c.env.DB, linkId, body.ref, body.playlist);
    if (!published) return c.json({ error: "invalid_manifest" }, 400);
    if (published.delisted) return c.json({ error: "delisted" }, 403);
    return c.json({ id: published.id }, 201);
  })
  .put("/publications/:id", async (c) => {
    const linkId = await linkOf(c);
    if (!linkId) return linkRevoked(c);
    const body = readPublication(await c.req.text());
    if (typeof body === "string") {
      const [status, error] = REFUSALS[body];
      return c.json({ error }, status);
    }
    return (await updatePublication(c.env.DB, linkId, c.req.param("id"), body.playlist))
      ? c.body(null, 204)
      : c.json({ error: "not_found" }, 404);
  })
  .delete("/publications/:id", async (c) => {
    const linkId = await linkOf(c);
    if (!linkId) return linkRevoked(c);
    await unpublish(c.env.DB, linkId, c.req.param("id"));
    return c.body(null, 204);
  })
  .get("/friends", async (c) => {
    const accountId = await accountOfLink(c);
    if (!accountId) return linkRevoked(c);
    return c.json(await friendLists(c.env.DB, accountId));
  })
  .get("/friends/blend-tracks", async (c) => {
    const accountId = await accountOfLink(c);
    if (!accountId) return linkRevoked(c);
    return c.json({ friends: await friendsBlendTracks(c.env.DB, accountId) });
  })
  .put("/friends/:handle", async (c) => {
    const accountId = await accountOfLink(c);
    if (!accountId) return linkRevoked(c);
    const status = await requestFriend(c.env.DB, accountId, c.req.param("handle"));
    if (status === "missing") return c.json({ error: "no_account" }, 404);
    if (status === "self") return c.json({ error: "self" }, 422);
    return c.json({ status });
  })
  .delete("/friends/:handle", async (c) => {
    const accountId = await accountOfLink(c);
    if (!accountId) return linkRevoked(c);
    await removeFriend(c.env.DB, accountId, c.req.param("handle"));
    return c.body(null, 204);
  })
  .put("/listening/now-playing", json(nowPlayingSchema), async (c) => {
    const linkId = await linkOf(c);
    if (!linkId) return linkRevoked(c);
    await setNowPlaying(c.env.DB, linkId, c.req.valid("json"));
    return c.body(null, 204);
  })
  .put("/listening/top-plays", json(sharedTopPlaysSchema), async (c) => {
    const linkId = await linkOf(c);
    if (!linkId) return linkRevoked(c);
    await setTopPlays(c.env.DB, linkId, c.req.valid("json"));
    return c.body(null, 204);
  })
  .delete("/listening", async (c) => {
    const linkId = await linkOf(c);
    if (!linkId) return linkRevoked(c);
    await clearListening(c.env.DB, linkId);
    return c.body(null, 204);
  })
  .get("/playlists", async (c) =>
    c.json({ playlists: await shelf(c.env.DB) }, 200, { "cache-control": "public, max-age=300" }),
  )
  .get("/profiles/:handle", async (c) => {
    const found = await profile(c.env.DB, c.req.param("handle"));
    return found
      ? c.json(found, 200, { "cache-control": "public, max-age=300" })
      : c.json({ error: "no_account" }, 404);
  })
  .get("/playlists/:id", async (c) => {
    const playlist = await publicPlaylist(c.env.DB, c.req.param("id"));
    return playlist ? c.json(playlist) : c.json({ error: "not_public" }, 404);
  })
  .use("/connect/*", async (c, next) => {
    const { appOrigin } = connectConfig(c.env);
    const origin = c.req.header("origin") ?? "";
    c.header("vary", "Origin");
    if (origin === appOrigin) {
      c.header("access-control-allow-origin", origin);
      if (c.req.method === "OPTIONS") {
        c.header("access-control-allow-methods", "GET, POST, OPTIONS");
        c.header("access-control-allow-headers", "Content-Type, Authorization");
        c.header("access-control-max-age", "600");
        return c.body(null, 204);
      }
    }
    await next();
  })
  .get("/connect/keys", async (c) =>
    c.json({ keys: await connectJwks(c.env.CONNECT_SIGNING_KEY) }, 200, {
      "cache-control": "public, max-age=3600",
    }),
  )
  .post("/connect/token", json(connectTokenSchema), async (c) => {
    const body = c.req.valid("json");
    const exchanged = await exchangeConnectAuthCode(c.env.DB, body);
    if (!exchanged) return c.json({ error: "invalid_grant" }, 400);
    return c.json({ token: exchanged.token, expiresAt: exchanged.expiresAt });
  })
  .post("/connect/sign-out", async (c) => {
    const token = bearer(c);
    if (token) await revokeConnectClientToken(c.env.DB, token);
    return c.body(null, 204);
  })
  .get("/connect/servers", async (c) => {
    const token = bearer(c);
    const accountId = token && (await resolveConnectClientAccount(c.env.DB, token));
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    const { connectDomain } = connectConfig(c.env);
    return c.json(await discoverConnectServers(c.env.DB, { accountId, connectDomain }));
  })
  .post("/connect/assertions", json(connectAssertionSchema), async (c) => {
    const token = bearer(c);
    const accountId = token && (await resolveConnectClientAccount(c.env.DB, token));
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    const { connectDomain } = connectConfig(c.env);
    const issued = await issueConnectAssertion(c.env.DB, {
      accountId,
      instanceId: c.req.valid("json").instanceId,
      signingKey: c.env.CONNECT_SIGNING_KEY,
      hubOrigin: c.env.HUB_ORIGIN,
      connectDomain,
    });
    if (!issued.ok) return c.json({ error: issued.error }, CONNECT_ERRORS[issued.error]);
    return c.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
      connectUrl: issued.connectUrl,
    });
  })
  .get("/connect/account", async (c) => {
    const token = bearer(c);
    const link = token && (await linkedLinkDetails(c.env.DB, await sha256Hex(token)));
    if (!link) return linkRevoked(c);
    return c.json(await getConnectAccountSummary(c.env.DB, link.account_id));
  })
  .post("/connect/servers", json(connectRegisterSchema), async (c) => {
    const token = bearer(c);
    const link = token && (await linkedLinkDetails(c.env.DB, await sha256Hex(token)));
    if (!link) return linkRevoked(c);
    const body = c.req.valid("json");
    if (link.instance_id !== body.instanceId) return c.json({ error: "wrong_instance" }, 403);
    if (!(await authorizeInstance(c.env.DB, body.instanceId, body.secret))) {
      return c.json({ error: "wrong_secret" }, 403);
    }
    const { connectDomain } = connectConfig(c.env);
    const registered = await registerConnectServer(c.env.DB, {
      instanceId: body.instanceId,
      ownerAccountId: link.account_id,
      slug: body.slug,
      name: body.name,
      lanHints: body.lanHints,
      startTrial: body.startTrial,
      connectDomain,
    });
    if (!registered.ok) {
      return c.json({ error: registered.error }, CONNECT_ERRORS[registered.error]);
    }
    return c.json({ server: registered.server, entitlement: registered.entitlement }, 201);
  })
  .patch("/connect/servers/:instanceId", json(connectUpdateSchema), async (c) => {
    const token = bearer(c);
    const link = token && (await linkedLinkDetails(c.env.DB, await sha256Hex(token)));
    if (!link) return linkRevoked(c);
    const instanceId = c.req.param("instanceId");
    if (link.instance_id !== instanceId) return c.json({ error: "wrong_instance" }, 403);
    const body = c.req.valid("json");
    const { connectDomain } = connectConfig(c.env);
    const updated = await updateConnectServer(c.env.DB, {
      instanceId,
      ownerAccountId: link.account_id,
      slug: body.slug,
      name: body.name,
      lanHints: body.lanHints,
      connectDomain,
    });
    if (!updated.ok) return c.json({ error: updated.error }, CONNECT_ERRORS[updated.error]);
    return c.json({ server: updated.server });
  })
  .delete("/connect/servers/:instanceId", async (c) => {
    const token = bearer(c);
    const link = token && (await linkedLinkDetails(c.env.DB, await sha256Hex(token)));
    if (!link) return linkRevoked(c);
    const instanceId = c.req.param("instanceId");
    if (link.instance_id !== instanceId) return c.json({ error: "wrong_instance" }, 403);
    const disabled = await disableConnectServer(c.env.DB, {
      instanceId,
      ownerAccountId: link.account_id,
    });
    if (!disabled.ok) return c.json({ error: disabled.error }, CONNECT_ERRORS[disabled.error]);
    return c.body(null, 204);
  })
  .post("/connect/ticket", json(connectTicketSchema), async (c) => {
    const body = c.req.valid("json");
    if (!(await authorizeInstance(c.env.DB, body.instanceId, body.secret))) {
      return c.json({ error: "wrong_secret" }, 403);
    }
    const { connectDomain, relayUrl } = connectConfig(c.env);
    const issued = await issueTunnelTicket(c.env.DB, {
      instanceId: body.instanceId,
      signingKey: c.env.CONNECT_SIGNING_KEY,
      hubOrigin: c.env.HUB_ORIGIN,
      connectDomain,
      relayUrl,
      lanHints: body.lanHints,
    });
    if (!issued.ok) return c.json({ error: issued.error }, CONNECT_ERRORS[issued.error]);
    return c.json({
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      slug: issued.slug,
      connectUrl: issued.connectUrl,
      relayUrl: issued.relayUrl,
    });
  })
  .post("/connect/relay/status", json(connectRelayStatusSchema), async (c) => {
    const secret = c.env.CONNECT_RELAY_SECRET;
    const provided = rawBearer(c);
    if (!secret || !provided || !(await sameSecret(provided, secret))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await updateRelayStatus(c.env.DB, c.req.valid("json").updates);
    return c.body(null, 204);
  })
  .post("/billing/polar/webhook", async (c) => {
    const polar = polarConfig(c.env);
    const webhookKey = decodePolarWebhookSecret(polar.webhookSecret);
    const allowedProductIds = allowedPolarProductIds(polar);
    if (!webhookKey || allowedProductIds.length === 0) {
      return c.json({ error: "billing_unconfigured" }, 503);
    }
    const rawBody = await c.req.text();
    if (rawBody.length > 128 * 1024) return c.json({ error: "payload_too_large" }, 413);

    const verified = await verifyPolarWebhookSignature(
      rawBody,
      {
        webhookId: c.req.header("webhook-id") ?? null,
        webhookTimestamp: c.req.header("webhook-timestamp") ?? null,
        webhookSignature: c.req.header("webhook-signature") ?? null,
      },
      webhookKey,
    );
    if (!verified.valid) return c.json({ error: "invalid_signature" }, 401);

    const parsed = parsePolarWebhookEvent(rawBody);
    if (parsed.kind === "invalid") return c.json({ error: "invalid_payload" }, 400);
    if (parsed.kind === "ignored") return c.json({ ok: true, ignored: true });

    const applied = await applyPolarSubscriptionEvent(c.env.DB, parsed.event, {
      allowedProductIds,
      webhookTimestampMs: verified.timestampMs,
    });
    return c.json({ ok: true, applied: applied.applied });
  });

const forwardCookies = (c: Context<Env>, headers: Headers) => {
  for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
};

async function sessionOf(c: Context<Env>) {
  const { headers, response } = await authFor(c.env).api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  forwardCookies(c, headers);
  return response;
}

const normalizeNext = (input: string | undefined | null) => {
  if (!input || input.length > 1024 || /[\r\n\\]/.test(input)) return null;
  return input.startsWith("/connect/authorize?") ? input : null;
};

const returnTo = (code: string | null, error?: string, next: string | null = null) => {
  if (next) {
    if (!error) return next;
    const url = new URL(next, "https://aurral.local");
    url.searchParams.set("error", error);
    return `${url.pathname}${url.search}`;
  }
  const params = new URLSearchParams(code ? { code } : {});
  if (error) params.set("error", error);
  return `${code ? "/link" : "/account"}${params.size ? `?${params}` : ""}`;
};

const formCode = async (c: Context<Env>) => {
  const form = await c.req.formData();
  return {
    form,
    code: normalizeCode(String(form.get("code") ?? "")),
    next: normalizeNext(String(form.get("next") ?? "")),
  };
};

async function signedIn(c: Context<Env>, code: string | null, next: string | null = null) {
  const session = await sessionOf(c);
  if (!session) {
    const providers = signInProviders(c.env).map((id) => ({
      id,
      label: PROVIDER_LABELS[id] ?? id,
    }));
    return {
      page: c.html(signInPage(providers, c.req.query("error") !== undefined, code, next)),
    };
  }
  const handle = await handleOf(c.env.DB, session.user.id);
  if (!handle) return { page: c.html(handlePage("", null, code, next)) };
  return { accountId: session.user.id, sessionId: session.session.id, handle };
}

function parseAuthorizeParams(
  source: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
  },
  appOrigin: string,
) {
  const clientId = CONNECT_CLIENTS.find((candidate) => candidate === source.clientId);
  if (!clientId) return null;
  if (!isAllowedRedirectUri(clientId, source.redirectUri, appOrigin)) return null;
  if (!PKCE_CHALLENGE.test(source.codeChallenge)) return null;
  if (!STATE_PATTERN.test(source.state)) return null;
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: source.redirectUri,
    code_challenge: source.codeChallenge,
    state: source.state,
  });
  return {
    clientId,
    redirectUri: source.redirectUri,
    codeChallenge: source.codeChallenge,
    state: source.state,
    next: `/connect/authorize?${query}`,
  };
}

function formActionForRedirect(redirectUri: string) {
  if (redirectUri.startsWith("aurral://")) return "'self' aurral:";
  try {
    return `'self' ${new URL(redirectUri).origin}`;
  } catch {
    return "'self'";
  }
}

const POLAR_FORM_ACTION = "'self' https://polar.sh https://buy.polar.sh https://sandbox.polar.sh";

const BILLING_ERROR_VALUES = new Set<AccountBillingError>(["unconfigured", "checkout", "portal"]);

const parseBillingError = (value: string | undefined): AccountBillingError | null =>
  value && BILLING_ERROR_VALUES.has(value as AccountBillingError)
    ? (value as AccountBillingError)
    : null;

const pageCsp = (formAction = "'self'") =>
  `default-src 'none'; style-src 'self'; img-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;

const pages = new Hono<Env>()
  .use(async (c, next) => {
    await next();
    if (!c.res.headers.has("content-security-policy")) {
      c.header("content-security-policy", pageCsp());
    }
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "same-origin");
    c.header("x-content-type-options", "nosniff");
  })
  .use((c, next) => csrf({ origin: c.env.HUB_ORIGIN })(c, next))
  .get("/account/style.css", (c) =>
    c.body(STYLE, 200, { "content-type": "text/css; charset=utf-8" }),
  )
  .get("/account", async (c) => {
    const user = await signedIn(c, null);
    if ("page" in user) return user.page;
    const polar = polarConfig(c.env);
    const { connectDomain } = connectConfig(c.env);
    const [provider, links, entitlement, servers] = await Promise.all([
      c.env.DB.prepare("SELECT provider FROM identities WHERE account_id = ?")
        .bind(user.accountId)
        .first<string>("provider"),
      accountLinks(c.env.DB, user.accountId),
      getConnectBillingSummary(c.env.DB, user.accountId),
      getOwnedConnectServers(c.env.DB, user.accountId, connectDomain),
    ]);
    const billingReady = isPolarBillingConfigured(polar);
    c.header("content-security-policy", pageCsp(POLAR_FORM_ACTION));
    return c.html(
      accountPage(user.handle, PROVIDER_LABELS[provider ?? ""] ?? "an unknown provider", links, {
        entitlement,
        servers,
        connectDomain,
        hasMonthlyPlan: Boolean(billingReady && polar.monthlyProductId),
        hasYearlyPlan: Boolean(billingReady && polar.yearlyProductId),
        portalConfigured: isPolarPortalConfigured(polar),
        emailPortalUrl: polar.portalUrl,
        checkoutSuccess: c.req.query("checkout") === "success",
        serverDisabled: c.req.query("server_disabled") === "1",
        billingError: parseBillingError(c.req.query("billing_error")),
      }),
    );
  })
  .post("/account/connect/checkout", async (c) => {
    const user = await signedIn(c, null);
    if ("page" in user) return c.redirect("/account");
    const form = await c.req.formData();
    const rawPlan = String(form.get("plan") ?? "monthly");
    const plan: PolarBillingPlan = rawPlan === "yearly" ? "yearly" : "monthly";
    const entitlement = await getConnectBillingSummary(c.env.DB, user.accountId);
    if (hasManagedPolarSubscription(entitlement)) {
      return c.redirect("/account", 303);
    }
    const polar = polarConfig(c.env);
    const hubOrigin = c.env.HUB_ORIGIN.replace(/\/+$/, "");
    const checkout = await createPolarCheckout(polar, {
      accountId: user.accountId,
      plan,
      successUrl: `${hubOrigin}/account?checkout=success`,
      returnUrl: `${hubOrigin}/account`,
    });
    if (!checkout.ok) {
      const code = checkout.error === "unconfigured" ? "unconfigured" : "checkout";
      return c.redirect(`/account?billing_error=${code}`, 303);
    }
    c.header("content-security-policy", pageCsp(POLAR_FORM_ACTION));
    return c.redirect(checkout.url, 303);
  })
  .post("/account/connect/portal", async (c) => {
    const user = await signedIn(c, null);
    if ("page" in user) return c.redirect("/account");
    const entitlement = await getConnectBillingSummary(c.env.DB, user.accountId);
    const polar = polarConfig(c.env);
    if (!entitlement.polarCustomerId) {
      if (polar.portalUrl) {
        c.header("content-security-policy", pageCsp(POLAR_FORM_ACTION));
        return c.redirect(polar.portalUrl, 303);
      }
      return c.redirect("/account?billing_error=portal", 303);
    }
    const hubOrigin = c.env.HUB_ORIGIN.replace(/\/+$/, "");
    const portal = await createPolarCustomerPortal(polar, {
      polarCustomerId: entitlement.polarCustomerId,
      returnUrl: `${hubOrigin}/account`,
    });
    if (!portal.ok) {
      const code = portal.error === "unconfigured" ? "unconfigured" : "portal";
      return c.redirect(`/account?billing_error=${code}`, 303);
    }
    c.header("content-security-policy", pageCsp(POLAR_FORM_ACTION));
    return c.redirect(portal.url, 303);
  })
  .get("/account/connect/servers/:instanceId/disable", async (c) => {
    const session = await sessionOf(c);
    if (!session) return c.redirect("/account");
    const { connectDomain } = connectConfig(c.env);
    const server = await getOwnedConnectServer(
      c.env.DB,
      session.user.id,
      c.req.param("instanceId"),
      connectDomain,
    );
    return server
      ? c.html(disableConnectServerPage(server, connectDomain))
      : c.redirect("/account");
  })
  .post("/account/connect/servers/:instanceId/disable", async (c) => {
    const session = await sessionOf(c);
    if (!session) return c.redirect("/account");
    const { connectDomain } = connectConfig(c.env);
    const owned = await getOwnedConnectServer(
      c.env.DB,
      session.user.id,
      c.req.param("instanceId"),
      connectDomain,
    );
    if (!owned) return c.redirect("/account");
    await disableConnectServer(c.env.DB, {
      instanceId: owned.instanceId,
      ownerAccountId: session.user.id,
    });
    return c.redirect("/account?server_disabled=1");
  })
  .get("/account/sign-in/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!signInProviders(c.env).includes(provider)) return c.notFound();
    const code = normalizeCode(c.req.query("code"));
    const next = normalizeNext(c.req.query("next"));
    const { headers, response } = await authFor(c.env).api.signInSocial({
      body: {
        provider,
        callbackURL: returnTo(code, undefined, next),
        errorCallbackURL: returnTo(code, "sign_in", next),
        disableRedirect: true,
      },
      returnHeaders: true,
    });
    if (!response.url) return c.redirect(returnTo(code, "sign_in", next));
    forwardCookies(c, headers);
    return c.redirect(response.url);
  })
  .post("/account/handle", async (c) => {
    const session = await sessionOf(c);
    const { form, code, next } = await formCode(c);
    if (!session) return c.redirect(returnTo(code, undefined, next));
    const value = String(form.get("handle") ?? "");
    const claim = await claimHandle(c.env.DB, session.user.id, value);
    if (claim === "claimed" || (await handleOf(c.env.DB, session.user.id))) {
      return c.redirect(returnTo(code, undefined, next));
    }
    return c.html(handlePage(value, claim, code, next), 422);
  })
  .post("/account/sign-out", async (c) => {
    const { code, next } = await formCode(c);
    const { headers } = await authFor(c.env).api.signOut({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    forwardCookies(c, headers);
    return c.redirect(returnTo(code, undefined, next));
  })
  .get("/account/delete", async (c) => {
    const session = await sessionOf(c);
    if (!session) return c.redirect("/account");
    const [handle, billing] = await Promise.all([
      handleOf(c.env.DB, session.user.id),
      getConnectBillingSummary(c.env.DB, session.user.id),
    ]);
    const hasActiveSubscription =
      hasManagedPolarSubscription(billing) && !billing.cancelAtPeriodEnd;
    return c.html(deletePage(handle, hasActiveSubscription));
  })
  .post("/account/delete", async (c) => {
    const session = await sessionOf(c);
    if (!session) return c.redirect("/account");
    const { headers } = await authFor(c.env).api.signOut({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    await deleteAccount(c.env.DB, session.user.id);
    forwardCookies(c, headers);
    return c.redirect("/account");
  })
  .get("/account/unlink/:id", async (c) => {
    const session = await sessionOf(c);
    const link = session && (await accountLink(c.env.DB, session.user.id, c.req.param("id")));
    return link ? c.html(unlinkPage(link)) : c.redirect("/account");
  })
  .post("/account/unlink/:id", async (c) => {
    const session = await sessionOf(c);
    if (session) await unlinkForAccount(c.env.DB, session.user.id, c.req.param("id"));
    return c.redirect("/account");
  })
  .get("/link", async (c) => {
    const code = normalizeCode(c.req.query("code"));
    const user = await signedIn(c, code);
    if ("page" in user) return user.page;
    if (!code) return c.html(linkCodePage(c.req.query("code") ? "missing" : null));
    if (!(await c.env.LINK_LIMITER.limit({ key: user.sessionId })).success) {
      return c.html(linkCodePage("busy"), 429);
    }
    const userName = await pendingLink(c.env.DB, code);
    return userName
      ? c.html(linkConfirmPage(user.handle, userName, code))
      : c.html(linkCodePage("missing"), 404);
  })
  .post("/link", async (c) => {
    const { code } = await formCode(c);
    const user = await signedIn(c, code);
    if ("page" in user) return user.page;
    if (!code) return c.html(linkCodePage("missing"), 404);
    if (!(await c.env.LINK_LIMITER.limit({ key: user.sessionId })).success) {
      return c.html(linkCodePage("busy"), 429);
    }
    return (await approveLink(c.env.DB, code, user.accountId))
      ? c.redirect("/account")
      : c.html(linkCodePage("missing"), 404);
  })
  .get("/connect/authorize", async (c) => {
    const { appOrigin } = connectConfig(c.env);
    const params = parseAuthorizeParams(
      {
        clientId: c.req.query("client_id") ?? "",
        redirectUri: c.req.query("redirect_uri") ?? "",
        codeChallenge: c.req.query("code_challenge") ?? "",
        state: c.req.query("state") ?? "",
      },
      appOrigin,
    );
    if (!params) {
      return c.html(connectErrorPage("That sign-in request isn't valid. Try starting again."), 400);
    }
    const user = await signedIn(c, null, params.next);
    if ("page" in user) return user.page;
    c.header("content-security-policy", pageCsp(formActionForRedirect(params.redirectUri)));
    return c.html(connectAuthorizePage(user.handle, CLIENT_LABELS[params.clientId], params));
  })
  .post("/connect/authorize", async (c) => {
    const { appOrigin } = connectConfig(c.env);
    const form = await c.req.formData();
    const params = parseAuthorizeParams(
      {
        clientId: String(form.get("client_id") ?? ""),
        redirectUri: String(form.get("redirect_uri") ?? ""),
        codeChallenge: String(form.get("code_challenge") ?? ""),
        state: String(form.get("state") ?? ""),
      },
      appOrigin,
    );
    if (!params) {
      return c.html(connectErrorPage("That sign-in request isn't valid. Try starting again."), 400);
    }
    const user = await signedIn(c, null, params.next);
    if ("page" in user) return user.page;
    const { code } = await createConnectAuthCode(c.env.DB, {
      accountId: user.accountId,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
    });
    const destination = new URL(params.redirectUri);
    destination.searchParams.set("code", code);
    destination.searchParams.set("state", params.state);
    c.header("content-security-policy", pageCsp(formActionForRedirect(params.redirectUri)));
    return c.redirect(destination.toString(), 302);
  });

const hub = new Hono<Env>().route("/v1", v1).route("/", pages);

export type Hub = typeof hub;
export default hub;
