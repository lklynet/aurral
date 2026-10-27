import { createMiddleware } from "hono/factory";
import { logger, safeLogDiagnostic } from "../services/logger.ts";
import type { AppEnv } from "./requestUser.ts";

const MAX_LOG_VALUE_LENGTH = 300;

function logValue(value: unknown) {
  return typeof value === "string" ? safeLogDiagnostic(value).slice(0, MAX_LOG_VALUE_LENGTH) : null;
}

async function responseReason(response: Response) {
  if (!response.headers.get("content-type")?.includes("json")) return null;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object") return null;
  return (
    ("message" in body && logValue(body.message)) ||
    ("error" in body && logValue(body.error)) ||
    null
  );
}

export function createRequestFailureLogger(log: Pick<typeof logger, "error"> = logger) {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();
    const { status } = c.res;
    const { path } = c.req;
    if (status < 500) return;
    if (!path.startsWith("/api/") && path !== "/rest" && !path.startsWith("/rest/")) return;
    const reason = await responseReason(c.res);
    log.error("http", "Request failed", {
      method: c.req.method,
      endpoint: logValue(path),
      status,
      ...(reason ? { reason } : {}),
    });
  });
}
