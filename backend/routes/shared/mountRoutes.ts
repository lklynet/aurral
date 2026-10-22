import { Router } from "express";

export default function mountRoutes(handlers, middleware = []) {
  const router = Router();
  if (middleware.length) router.use(...middleware);
  for (const register of handlers) register(router);
  return router;
}
