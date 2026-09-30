import { test, expect } from "@playwright/test";

test("Flow status uses the canonical channel and refreshes after reconnect", async ({ page }) => {
  const username = process.env.AUTH_USER;
  const password = process.env.AUTH_PASSWORD;
  if (!username || !password) throw new Error("AUTH_USER and AUTH_PASSWORD are required");
  await page.addInitScript(() => {
    window.flowStatusCheck = { sockets: [], channels: [], reads: 0 };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.flowStatusCheck.sockets.push(this);
      }
      send(data) {
        const message = JSON.parse(data);
        if (message.type === "subscribe") window.flowStatusCheck.channels.push(...message.channels);
        super.send(data);
      }
    };
    const nativeFetch = window.fetch;
    window.fetch = function (input, ...args) {
      if (String(input).includes("/playlists/status")) window.flowStatusCheck.reads++;
      return nativeFetch.call(this, input, ...args);
    };
  });
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Primary navigation")).toBeVisible();
  await page.locator("a[href='/flows']").click();
  await expect.poll(() => page.evaluate(() => window.flowStatusCheck.channels)).toContain("playlists");
  expect(await page.evaluate(() => window.flowStatusCheck.channels)).not.toContain("weekly-flow");
  const previous = await page.evaluate(() => {
    const check = window.flowStatusCheck;
    const result = { reads: check.reads, sockets: check.sockets.length };
    check.sockets.at(-1).close(4001, "Reconnect check");
    return result;
  });
  await expect.poll(() => page.evaluate(() => window.flowStatusCheck.sockets.length)).toBeGreaterThan(previous.sockets);
  await expect.poll(() => page.evaluate(() => window.flowStatusCheck.reads)).toBeGreaterThan(previous.reads);
  expect(await page.evaluate(() => window.flowStatusCheck.channels)).not.toContain("weekly-flow");
});
