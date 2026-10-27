import { Hono } from "hono";
import { clientAddress } from "./middleware/clientAddress.ts";
import { authenticate } from "./middleware/guards.ts";
import { rateLimit } from "./middleware/rateLimit.ts";
import { createRequestFailureLogger } from "./middleware/requestFailureLogger.ts";
import type { AppEnv } from "./middleware/requestUser.ts";
import { corsHeaders, securityHeaders } from "./middleware/security.ts";
import { api, handleError } from "./routes/api.ts";
import frontend from "./routes/frontend.ts";
import sso from "./routes/sso.ts";
import subsonic from "./routes/subsonic.ts";
import { noteDeprecatedUsage } from "./services/deprecatedUsage.ts";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const signInLimit = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 10,
  skipSuccessfulRequests: true,
});

export const app = new Hono<AppEnv>({ strict: false })
  .use(async (c, next) => {
    const incoming = c.env.incoming.headers;
    if (incoming["transfer-encoding"]) {
      // bodyLimit rebuilds chunked requests with new Request(), which rejects node-server's lightweight request.
      const { url, method, headers, body, signal } = c.req.raw;
      const init = { method, headers, body, signal, duplex: "half" };
      c.req.raw = new Request(url, init);
    } else if (
      !Number(incoming["content-length"]) &&
      incoming["content-type"]?.includes("json") &&
      c.req.method !== "GET" &&
      c.req.method !== "HEAD"
    ) {
      // Clients send JSON content types with no body, and the API has always read that as {}.
      const { url, method, headers, signal } = c.req.raw;
      c.req.raw = new Request(url, { method, headers, signal, body: "{}" });
    }
    await next();
  })
  .use(clientAddress)
  .use(corsHeaders)
  .use(createRequestFailureLogger())
  .use(securityHeaders)
  .use(rateLimit({ windowMs: FIFTEEN_MINUTES, limit: 5000 }))
  .use(authenticate)
  .use("/api/auth/login", signInLimit)
  .use("/api/auth/oidc/login", signInLimit)
  .use("/api/auth/oidc/exchange", signInLimit)
  .use("/api/users/me/password", signInLimit)
  .all("/api/weekly-flow/*", (c) => {
    noteDeprecatedUsage("weekly-flow-api");
    const { pathname, search } = new URL(c.req.url);
    const rest = pathname.slice("/api/weekly-flow".length) || "/";
    return c.redirect(`/api/playlists${rest}${search}`, 308);
  })
  .route("/api", api)
  .route("/", subsonic)
  .route("/", sso)
  .route("/", frontend)
  .notFound((c) =>
    c.req.path.startsWith("/api") ? c.json({ error: "Not found" }, 404) : c.text("Not found", 404),
  )
  .onError(handleError);
