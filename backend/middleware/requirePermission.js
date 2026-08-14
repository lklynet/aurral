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

export function isRecentlyAuthenticated(req, maxAgeMinutes = DEFAULT_REAUTH_MAX_AGE_MINUTES) {
  const token = getBearerToken(req);
  if (!token) return true;
  const session = getSessionByToken(token);
  if (!session) return false;
  const ageMs = Date.now() - session.reauthenticatedAt;
  return ageMs <= maxAgeMinutes * 60 * 1000;
}

export function requireRecentAuth(maxAgeMinutes = DEFAULT_REAUTH_MAX_AGE_MINUTES) {
  return (req, res, next) => {
    if (!req.user) {
      return sendUnauthorizedResponse(req, res);
    }
    if (!isRecentlyAuthenticated(req, maxAgeMinutes)) {
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
