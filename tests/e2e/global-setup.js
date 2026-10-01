import fs from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { request } from "@playwright/test";

export const AUTH_STATE_PATH = fileURLToPath(new URL("../../playwright/.auth/user.json", import.meta.url));

function isLoopback(url) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."));
}

export default async function globalSetup(config) {
  const baseURL = config.projects[0].use.baseURL;
  const username = String(process.env.AUTH_USER || "").trim();
  const password = String(process.env.AUTH_PASSWORD || "");
  let origins = [];
  if (username && password) {
    const url = new URL(baseURL);
    if (url.protocol !== "https:" && !isLoopback(url)) {
      throw new Error("Refusing to submit test credentials over insecure transport");
    }
    const api = await request.newContext({ baseURL });
    try {
      const response = await api.post("/api/auth/login", { data: { username, password } });
      if (!response.ok()) throw new Error(`Signing in for the browser suite failed with HTTP ${response.status()}`);
      const { token } = await response.json();
      origins = [{ origin: url.origin, localStorage: [{ name: "auth_token", value: token }] }];
    } finally {
      await api.dispose();
    }
  }
  await fs.mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await fs.writeFile(AUTH_STATE_PATH, JSON.stringify({ cookies: [], origins }));
}
