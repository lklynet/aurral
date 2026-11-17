import type { D1Database, RateLimit } from "@cloudflare/workers-types/index.ts";
import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { validator } from "hono/validator";
import * as v from "valibot";
import { authFor, socialProviders } from "./auth.ts";
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
  deletePage,
  handlePage,
  linkCodePage,
  linkConfirmPage,
  signInPage,
  STYLE,
  unlinkPage,
} from "./pages.ts";

export type Bindings = {
  DB: D1Database;
  LINK_LIMITER: RateLimit;
  HUB_ORIGIN: string;
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

export const signInProviders = (env: Bindings) => [
  ...Object.keys(socialProviders(env)),
  ...(env.EDEN_OIDC_ISSUER ? ["eden"] : []),
];

const TOKEN = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const instance = { instanceId: v.string(), secret: v.string() };
const startSchema = v.object({
  ...instance,
  token: TOKEN,
  userName: v.pipe(
    v.string(),
    v.transform((name) =>
      name
        .replace(/\p{Cc}/gu, " ")
        .trim()
        .slice(0, 64),
    ),
    v.minLength(1),
  ),
});
const revokeSchema = v.object({ ...instance, tokenHash: v.pipe(v.string(), v.hexadecimal()) });

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

const returnTo = (code: string | null, error?: string) => {
  const params = new URLSearchParams(code ? { code } : {});
  if (error) params.set("error", error);
  return `${code ? "/link" : "/account"}${params.size ? `?${params}` : ""}`;
};

const formCode = async (c: Context<Env>) => {
  const form = await c.req.formData();
  return { form, code: normalizeCode(String(form.get("code") ?? "")) };
};

async function signedIn(c: Context<Env>, code: string | null) {
  const session = await sessionOf(c);
  if (!session) {
    const providers = signInProviders(c.env).map((id) => ({
      id,
      label: PROVIDER_LABELS[id] ?? id,
    }));
    return { page: c.html(signInPage(providers, c.req.query("error") !== undefined, code)) };
  }
  const handle = await handleOf(c.env.DB, session.user.id);
  if (!handle) return { page: c.html(handlePage("", null, code)) };
  return { accountId: session.user.id, sessionId: session.session.id, handle };
}

const pages = new Hono<Env>()
  .use(async (c, next) => {
    await next();
    c.header(
      "content-security-policy",
      "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
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
    const provider = await c.env.DB.prepare("SELECT provider FROM identities WHERE account_id = ?")
      .bind(user.accountId)
      .first<string>("provider");
    return c.html(
      accountPage(
        user.handle,
        PROVIDER_LABELS[provider ?? ""] ?? "an unknown provider",
        await accountLinks(c.env.DB, user.accountId),
      ),
    );
  })
  .get("/account/sign-in/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!signInProviders(c.env).includes(provider)) return c.notFound();
    const code = normalizeCode(c.req.query("code"));
    const { headers, response } = await authFor(c.env).api.signInSocial({
      body: {
        provider,
        callbackURL: returnTo(code),
        errorCallbackURL: returnTo(code, "sign_in"),
        disableRedirect: true,
      },
      returnHeaders: true,
    });
    if (!response.url) return c.redirect(returnTo(code, "sign_in"));
    forwardCookies(c, headers);
    return c.redirect(response.url);
  })
  .post("/account/handle", async (c) => {
    const session = await sessionOf(c);
    const { form, code } = await formCode(c);
    if (!session) return c.redirect(returnTo(code));
    const value = String(form.get("handle") ?? "");
    const claim = await claimHandle(c.env.DB, session.user.id, value);
    if (claim === "claimed" || (await handleOf(c.env.DB, session.user.id))) {
      return c.redirect(returnTo(code));
    }
    return c.html(handlePage(value, claim, code), 422);
  })
  .post("/account/sign-out", async (c) => {
    const { code } = await formCode(c);
    const { headers } = await authFor(c.env).api.signOut({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    forwardCookies(c, headers);
    return c.redirect(returnTo(code));
  })
  .get("/account/delete", async (c) => {
    const session = await sessionOf(c);
    if (!session) return c.redirect("/account");
    return c.html(deletePage(await handleOf(c.env.DB, session.user.id)));
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
  });

const hub = new Hono<Env>().route("/v1", v1).route("/", pages);

export type Hub = typeof hub;
export default hub;
