import {
  hasPermission,
  isRecentlyAuthenticated,
  sendUnauthorizedResponse,
  type AuthRequest,
} from "./auth.ts";
import type { Response, NextFunction } from "express";

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

export function requireRecentAuth(maxAgeMinutes?: number) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return sendUnauthorizedResponse(req, res);
    }
    if (!isRecentlyAuthenticated(req.headers.authorization, maxAgeMinutes)) {
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
