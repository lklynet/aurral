export const cacheMiddleware = (maxAge) => (req, res, next) => {
  if (req.method !== "GET") return next();
  res.set("Cache-Control", `public, max-age=${maxAge}`);
  res.set("Vary", "Accept");
  if (maxAge > 0) {
    res.set("Expires", new Date(Date.now() + maxAge * 1000).toUTCString());
  }
  next();
};

export const noCache = (req, res, next) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
};
