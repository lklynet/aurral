import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const artist = { id: "skeleton-artist", name: "Skeleton Artist", tags: [], genres: [] };

async function fixture(page, { holdDiscover }) {
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/health/bootstrap") {
      return json({ authRequired: false, onboardingRequired: false, lidarrConfigured: true });
    }
    if (path === "/health") return json({ lidarrConfigured: true });
    if (path === "/discover") {
      await holdDiscover;
      return json({ recommendations: [artist], configured: true });
    }
    if (path === "/discover/editorial") return json({ forYou: [], genres: [] });
    if (path === "/library/lookup/batch") {
      return json(Object.fromEntries((request.postDataJSON()?.mbids || []).map((id) => [id, false])));
    }
    if (path.endsWith("/cover")) return json({ images: [] });
    if (path === "/artists/release-groups/covers") return json({});
    if (path === "/users/me/discover-layout") return json({ layout: [] });
    if (path === "/settings") return json({});
    if (path === "/discover/feedback") return json({ feedback: [] });
    if (path === "/library/favorites") return json({});
    return json([]);
  });
}

test("Discover keeps its heading and reserves section space while loading", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release;
  await fixture(page, { holdDiscover: new Promise((resolve) => { release = resolve; }) });
  await page.goto("/");

  const busy = page.locator("main [aria-busy=true]").first();
  await expect(page.getByRole("heading", { name: "Discover", level: 1 })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Loading recommendations" })).toBeVisible();
  const reserved = await busy.boundingBox();
  expect(reserved.height).toBeGreaterThan(800);
  const animations = await busy.evaluate((node) =>
    [...node.querySelectorAll("[aria-hidden=true] *")].map((child) => getComputedStyle(child).animationName),
  );
  expect(animations.length).toBeGreaterThan(0);
  expect(animations.every((name) => name === "none")).toBe(true);
  await testInfo.attach("discover-skeleton", { body: await page.screenshot(), contentType: "image/png" });

  release();
  await expect(page.locator("main").getByRole("link", { name: `Open ${artist.name}`, exact: true }).first()).toBeVisible();
  await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
});
