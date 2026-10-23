import assert from "node:assert/strict";
import { Router, type Request, type Response, type RequestHandler } from "express";

export function createRouteHarness(...register: ((router: Router) => void)[]) {
  const router = Router();
  for (const setup of register) setup(router);
  return {
    get(key: string) {
      const [method, routePath] = key.split(" ");
      const route = router.stack.find(
        (layer) =>
          layer.route?.path === routePath &&
          layer.route.stack.some(
            (handler: { method: string }) => handler.method === method.toLowerCase(),
          ),
      )?.route;
      assert.ok(route, `Missing route: ${key}`);
      const handler: RequestHandler | undefined = route.stack.at(-1)?.handle;
      assert.ok(handler);
      return (request: unknown, response: unknown) =>
        handler(request as Request, response as Response, (error?: unknown) => {
          if (error) throw error;
        });
    },
  };
}

export function captureRouteHandlers(register: (router: Router) => void, method: string) {
  const routes = createRouteHarness(register);
  return { get: (path: string) => routes.get(`${method} ${path}`) };
}

export function createResponse<Body>() {
  let body: Body | undefined;
  return {
    statusCode: 200,
    get body() {
      assert.ok(body !== undefined, "Route did not send a response");
      return body;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: Body) {
      body = value;
      return this;
    },
    set() {
      return this;
    },
  };
}
