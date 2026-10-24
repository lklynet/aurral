import { createMiddleware } from "hono/factory";
import { getUnauthorizedDetails } from "./auth.ts";
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
