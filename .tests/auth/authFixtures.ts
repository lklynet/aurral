import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { Request } from "express";

export function createAuthRequest(overrides: Partial<Request> = {}) {
  const request = new IncomingMessage(new Socket()) as Request;
  Object.assign(request, {
    headers: {},
    query: {},
    path: "/",
    method: "GET",
    ip: "127.0.0.1",
    ips: [],
    secure: false,
    body: {},
    ...overrides,
  });
  return request;
}
