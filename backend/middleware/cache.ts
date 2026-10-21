import type { NextFunction, Request, Response } from "express";

export const cacheMiddleware =
  (maxAge: number) => (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();
    res.set("Cache-Control", `public, max-age=${maxAge}`);
    res.set("Vary", "Accept");
    if (maxAge > 0) {
      res.set("Expires", new Date(Date.now() + maxAge * 1000).toUTCString());
    }
    next();
  };

export const noCache = (req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
};
