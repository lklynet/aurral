import { Hono } from "hono";
import { AuthorizationResponseError, ResponseBodyError } from "openid-client";
import { asAppError } from "../../lib/errors.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { handleGoogleCallback } from "../services/googleAuth.ts";
import { logger } from "../services/logger.ts";
import { handleOidcCallback } from "../services/oidcAuth.ts";

const callbackFailure = (error: unknown) => ({
  message: asAppError(error)?.message,
  ...((error instanceof ResponseBodyError || error instanceof AuthorizationResponseError) && {
    error: error.error,
    description: error.error_description,
  }),
});

export default new Hono<AppEnv>()
  .basePath("/sso")
  .get("/callback", async (c) => {
    try {
      const { code } = await handleOidcCallback(c.req.query(), c.req.header("cookie"));
      return c.redirect(`/sso/complete#code=${encodeURIComponent(code)}`, 302);
    } catch (error) {
      const failure = callbackFailure(error);
      logger.error("auth", "OIDC callback failed:", failure);
      const reason = encodeURIComponent(failure.message || "OIDC login failed");
      return c.redirect(`/sso/complete#error=${reason}`, 302);
    }
  })
  .get("/google/callback", async (c) => {
    try {
      const { code } = await handleGoogleCallback(c.req.query(), c.req.header("cookie"));
      return c.redirect(`/sso/complete#code=${encodeURIComponent(code)}&provider=google`, 302);
    } catch (error) {
      const failure = callbackFailure(error);
      logger.error("auth", "Google callback failed:", failure);
      const reason = encodeURIComponent(failure.message || "Google login failed");
      return c.redirect(`/sso/complete#error=${reason}&provider=google`, 302);
    }
  });
