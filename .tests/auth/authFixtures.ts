import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { Request, Response } from "express";

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

type AuthBody = { authUrl?: string; retryable?: boolean; token?: string; error?: string };

export function createAuthResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    location: undefined as string | undefined,
    body: null as AuthBody | null,
    append(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    redirect(_status: number, location: string) {
      this.location = location;
    },
    json(body: AuthBody) {
      this.body = body;
      return this;
    },
  };
  return response as typeof response & Response;
}
