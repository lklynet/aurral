import { isIP } from "node:net";
import { expect, test } from "@playwright/test";

export const credentials = {
  username: String(process.env.AUTH_USER || "").trim(),
  password: String(process.env.AUTH_PASSWORD || ""),
};

export function requireCredentials() {
  test.beforeAll(() => {
    if (!credentials.username || !credentials.password) {
      throw new Error("AUTH_USER and AUTH_PASSWORD are required for the full browser suite");
    }
  });
}

export function assertSafeCredentialTransport(address) {
  const url = new URL(address);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const isLoopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("Refusing to submit test credentials over insecure transport");
  }
}

export async function openApp(page, navigation = "Primary navigation") {
  await page.goto("/");
  await expect(page.getByLabel(navigation)).toBeVisible();
}

export function apiRequest(page, path, { method = "GET", body } = {}) {
  return page.evaluate(async ({ requestPath, requestMethod, requestBody }) => {
    const token = localStorage.getItem("auth_token");
    const response = await fetch(requestPath, {
      method: requestMethod,
      headers: {
        ...(requestBody === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      credentials: "include",
      cache: "no-store",
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }, { requestPath: path, requestMethod: method, requestBody: body });
}

export async function useAurralWithoutLidarr(page) {
  const settings = await apiRequest(page, "/api/settings");
  expect(settings.ok).toBe(true);
  const wasEnabled = settings.body?.integrations?.lidarr?.enabled !== false;
  const setEnabled = async (enabled) => {
    const response = await apiRequest(page, "/api/settings", {
      method: "POST",
      body: { integrations: { lidarr: { enabled } } },
    });
    expect(response.ok).toBe(true);
  };
  await setEnabled(false);
  await expect
    .poll(async () => (await apiRequest(page, "/api/health")).body?.lidarrConfigured)
    .toBe(false);
  return () => (wasEnabled ? setEnabled(true) : undefined);
}
