import { hasPermission, sendUnauthorizedResponse } from "./auth.js";

export function requireAuth(req, res, next) {
  if (!req.user) {
    return sendUnauthorizedResponse(req, res);
  }
  next();
}

export function requireUserAccount(req, res, next) {
  const userId = Number(req.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(403).json({
      error: "User account required",
      message: "Authenticate as a user account before using this endpoint.",
    });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden", message: "Admin access required" });
  }
  next();
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
