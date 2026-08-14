import { hasPermission, sendUnauthorizedResponse } from "./auth.js";
import { getSessionByToken } from "../config/session-helpers.js";

const DEFAULT_REAUTH_MAX_AGE_MINUTES = 15;

function getBearerToken(req) {
  const authHeader = String(req.headers?.authorization || "");
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return sendUnauthorizedResponse(req, res);
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden", message: "Admin access required" });
  }
  next();
}

// Requires the caller's session to have been authenticated (or explicitly
// reauthenticated via POST /api/auth/reauth) within the last maxAgeMinutes.
// Non-session auth (proxy headers, API key) is re-verified on every request
// by its own trust model, so it has no meaningful "session age" and is
// allowed through unchanged.
export function requireRecentAuth(maxAgeMinutes = DEFAULT_REAUTH_MAX_AGE_MINUTES) {
  return (req, res, next) => {
    if (!req.user) {
      return sendUnauthorizedResponse(req, res);
    }
    const token = getBearerToken(req);
    if (!token) return next();
    const session = getSessionByToken(token);
    if (!session) {
      return sendUnauthorizedResponse(req, res);
    }
    const ageMs = Date.now() - session.reauthenticatedAt;
    if (ageMs > maxAgeMinutes * 60 * 1000) {
      return res.status(401).json({
        error: "reauth_required",
        message: "Please confirm your credentials to continue",
      });
    }
    next();
  };
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return sendUnauthorizedResponse(req, res);
    }
    if (!hasPermission(req.user, permission)) {
      return res.status(403).json({
        error: "Forbidden",
        message: `Permission required: ${permission}`,
      });
    }
    next();
  };
}
