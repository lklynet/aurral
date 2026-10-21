import { hasPermission, sendUnauthorizedResponse, type AuthRequest } from "./auth.ts";
import { getSessionByToken } from "../config/session-helpers.ts";
import type { Response, NextFunction } from "express";

const DEFAULT_REAUTH_MAX_AGE_MINUTES = 15;

function getBearerToken(req: AuthRequest) {
  const authHeader = String(req.headers?.authorization || "");
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return sendUnauthorizedResponse(req, res);
  }
  next();
}

export function requireUserAccount(req: AuthRequest, res: Response, next: NextFunction) {
  const userId = Number(req.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(403).json({
      error: "User account required",
      message: "Authenticate as a user account before using this endpoint.",
    });
  }
  next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden", message: "Admin access required" });
  }
  next();
}

export function isRecentlyAuthenticated(
  req: AuthRequest,
  maxAgeMinutes = DEFAULT_REAUTH_MAX_AGE_MINUTES,
) {
  const token = getBearerToken(req);
  if (!token) return false;
  const session = getSessionByToken(token);
  if (!session) return false;
  const ageMs = Date.now() - session.reauthenticatedAt;
  return ageMs <= maxAgeMinutes * 60 * 1000;
}

export function requireRecentAuth(maxAgeMinutes = DEFAULT_REAUTH_MAX_AGE_MINUTES) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
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

export function requirePermission(permission: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
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
