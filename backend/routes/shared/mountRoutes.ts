import { Router, type RequestHandler } from "express";

export default function mountRoutes(
  handlers: ((router: Router) => void)[],
  middleware: RequestHandler[] = [],
) {
  const router = Router();
  if (middleware.length) router.use(...middleware);
  for (const register of handlers) register(router);
  return router;
}
