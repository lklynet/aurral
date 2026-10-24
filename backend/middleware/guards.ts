import { createMiddleware } from "hono/factory";
import { getUnauthorizedDetails, isAuthRequiredByConfig } from "./auth.ts";
import type { AppEnv, RequestUser } from "./requestUser.ts";

export const requireAuth = createMiddleware<AppEnv & { Variables: { user: RequestUser } }>(
  async (c, next) => {
    const user: RequestUser | undefined = c.get("user");
    if (!user) {
      return c.json(
        { error: "Unauthorized", ...getUnauthorizedDetails(c.req.header("authorization")) },
        401,
      );
    }
    await next();
  },
);

export const requireStreamAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user") && isAuthRequiredByConfig()) {
    return c.json({ error: "Unauthorized", message: "Authentication required" }, 401);
  }
  await next();
});
