import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { authFor, socialProviders } from "./auth.ts";
import { claimHandle, deleteAccount, handleOf } from "./handles.ts";
import { accountPage, deletePage, handlePage, signInPage, STYLE } from "./pages.ts";

export type Bindings = {
  DB: D1Database;
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

const v1 = new Hono<Env>()
  .get("/health", (c) => c.json({ ok: true }))
  .on(["GET", "POST"], "/auth/*", (c) => authFor(c.env).handler(c.req.raw));

const forwardCookies = (c: Context<Env>, headers: Headers) => {
  for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
};

const sessionOf = (c: Context<Env>) =>
  authFor(c.env).api.getSession({ headers: c.req.raw.headers });

const account = new Hono<Env>()
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
  .get("/style.css", (c) => c.body(STYLE, 200, { "content-type": "text/css; charset=utf-8" }))
  .get("/", async (c) => {
    const session = await sessionOf(c);
    if (!session) {
      const providers = signInProviders(c.env).map((id) => ({
        id,
        label: PROVIDER_LABELS[id] ?? id,
      }));
      return c.html(signInPage(providers, c.req.query("error") !== undefined));
    }
    const handle = await handleOf(c.env.DB, session.user.id);
    if (!handle) return c.html(handlePage());
    const provider = await c.env.DB.prepare("SELECT provider FROM identities WHERE account_id = ?")
      .bind(session.user.id)
      .first<string>("provider");
    return c.html(accountPage(handle, PROVIDER_LABELS[provider ?? ""] ?? "an unknown provider"));
  })
  .get("/sign-in/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!signInProviders(c.env).includes(provider)) return c.notFound();
    const { headers, response } = await authFor(c.env).api.signInSocial({
      body: {
        provider,
        callbackURL: "/account",
        errorCallbackURL: "/account?error=sign_in",
        disableRedirect: true,
      },
      returnHeaders: true,
    });
    if (!response.url) return c.redirect("/account?error=sign_in");
    forwardCookies(c, headers);
    return c.redirect(response.url);
  })
  .post("/handle", async (c) => {
    const session = await sessionOf(c);
    if (!session) return c.redirect("/account");
    const form = await c.req.formData();
    const value = String(form.get("handle") ?? "");
    const claim = await claimHandle(c.env.DB, session.user.id, value);
    if (claim === "claimed" || (await handleOf(c.env.DB, session.user.id))) {
      return c.redirect("/account");
    }
    return c.html(handlePage(value, claim), 422);
  })
  .post("/sign-out", async (c) => {
    const { headers } = await authFor(c.env).api.signOut({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    forwardCookies(c, headers);
    return c.redirect("/account");
  })
  .get("/delete", async (c) => {
    const session = await sessionOf(c);
    const handle = session && (await handleOf(c.env.DB, session.user.id));
    return handle ? c.html(deletePage(handle)) : c.redirect("/account");
  })
  .post("/delete", async (c) => {
    const session = await sessionOf(c);
    if (!session) return c.redirect("/account");
    const { headers } = await authFor(c.env).api.signOut({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    await deleteAccount(c.env.DB, session.user.id);
    forwardCookies(c, headers);
    return c.redirect("/account");
  });

const hub = new Hono<Env>().route("/v1", v1).route("/account", account);

export type Hub = typeof hub;
export default hub;
