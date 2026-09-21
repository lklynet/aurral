import { createServer } from "node:http";
import { expect, test } from "@playwright/test";

const username = String(process.env.AUTH_USER || "").trim();
const password = String(process.env.AUTH_PASSWORD || "");

test.beforeAll(() => {
  if (!username || !password) {
    throw new Error("AUTH_USER and AUTH_PASSWORD are required for the full browser suite");
  }
});

async function signIn(page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Primary navigation")).toBeVisible();
}

async function apiRequest(page, path, { method = "GET", body } = {}) {
  return page.evaluate(async ({ requestPath, requestMethod, requestBody }) => {
    const token = localStorage.getItem("auth_token");
    const headers = {
      ...(requestBody === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const response = await fetch(requestPath, {
      method: requestMethod,
      headers,
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      credentials: "include",
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }, { requestPath: path, requestMethod: method, requestBody: body });
}

async function startReceiver() {
  const requests = [];
  let responseStatus = 200;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: rawBody ? JSON.parse(rawBody) : null,
      });
      res.writeHead(responseStatus, { "content-type": "text/plain" });
      res.end(responseStatus === 200 ? "ok" : "failed");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    requests,
    setResponseStatus(status) {
      responseStatus = status;
    },
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  };
}

test("tests the selected webhook without saving settings", async ({ page }) => {
  await signIn(page);
  const currentSettings = await apiRequest(page, "/api/settings");
  expect(currentSettings.ok).toBe(true);
  const originalWebhooks = currentSettings.body?.integrations?.webhooks || [];
  const originalWebhookEvents = currentSettings.body?.integrations?.webhookEvents || {};
  const receiver = await startReceiver();
  const webhook = {
    url: receiver.url,
    body: '{"event":"$event","album":"$albumName"}',
    headers: [{ key: "X-Aurral-Test", value: "playwright" }],
  };

  try {
    const configured = await apiRequest(page, "/api/settings", {
      method: "POST",
      body: {
        integrations: {
          webhooks: [webhook],
          webhookEvents: {
            notifyDiscoveryUpdated: false,
            notifyWeeklyFlowDone: false,
            notifyRequestMade: false,
            notifyRequestAvailable: false,
          },
        },
      },
    });
    expect(configured.ok).toBe(true);

    await page.goto("/settings/connect");
    const card = page.locator(".arr-webhook-card").first();
    await expect(card).toBeVisible();
    const settingsPosts = [];
    const onRequest = (request) => {
      const requestUrl = new URL(request.url());
      if (request.method() === "POST" && requestUrl.pathname === "/api/settings") {
        settingsPosts.push(request);
      }
    };
    page.on("request", onRequest);

    const testButton = card.getByRole("button", { name: "Test webhook", exact: true });
    await expect(testButton).toBeEnabled();
    await testButton.click();
    await expect(card.getByRole("status")).toHaveText("Test webhook sent.");
    await expect.poll(() => receiver.requests.length).toBe(1);
    expect(receiver.requests[0].method).toBe("POST");
    expect(receiver.requests[0].body).toEqual({
      event: "webhookTest",
      album: "Test album",
    });
    expect(receiver.requests[0].headers["x-aurral-test"]).toBe("playwright");
    expect(settingsPosts).toHaveLength(0);

    receiver.setResponseStatus(500);
    await testButton.click();
    await expect(card.getByRole("alert")).toHaveText(
      "Test failed. Check the URL, body, and headers, then retry.",
    );
    await expect.poll(() => receiver.requests.length).toBe(2);
    page.off("request", onRequest);
  } finally {
    await receiver.close();
    const restored = await apiRequest(page, "/api/settings", {
      method: "POST",
      body: {
        integrations: {
          webhooks: originalWebhooks,
          webhookEvents: originalWebhookEvents,
        },
      },
    });
    expect(restored.ok).toBe(true);
  }
});
