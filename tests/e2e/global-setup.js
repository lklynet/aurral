import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "@playwright/test";
import { assertSafeCredentialTransport } from "./helpers.js";

export const AUTH_STATE_PATH = fileURLToPath(new URL("../../playwright/.auth/user.json", import.meta.url));

export default async function globalSetup(config) {
  const baseURL = config.projects[0].use.baseURL;
  const username = String(process.env.AURRAL_TEST_USERNAME || "").trim();
  const password = String(process.env.AURRAL_TEST_PASSWORD || "");
  let origins = [];
  if (username && password) {
    const url = new URL(baseURL);
    assertSafeCredentialTransport(baseURL);
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
