import { logger, safeLogDiagnostic } from "../services/logger.js";

const MAX_LOG_VALUE_LENGTH = 300;

function logValue(value) {
  return typeof value === "string"
    ? safeLogDiagnostic(value).slice(0, MAX_LOG_VALUE_LENGTH)
    : null;
}

export function createRequestFailureLogger(log = logger) {
  return (req, res, next) => {
    let responseReason = null;
    const sendJson = res.json;
    res.json = function (body) {
      if (res.statusCode >= 500 && body && typeof body === "object") {
        responseReason = logValue(body.message) || logValue(body.error);
      }
      return sendJson.call(this, body);
    };

    res.once("finish", () => {
      if (res.statusCode < 500 || res.locals?.failureLogged) return;
      const route = req.route?.path;
      const endpoint = typeof route === "string"
        ? `${req.baseUrl || ""}${route}`
        : req.path;
      if (!endpoint?.startsWith("/api/") && endpoint !== "/rest" && !endpoint?.startsWith("/rest/")) return;
      log.error("http", "Request failed", {
        method: req.method,
        endpoint: logValue(endpoint),
        status: res.statusCode,
        ...(responseReason ? { reason: responseReason } : {}),
      });
    });
    next();
  };
}
