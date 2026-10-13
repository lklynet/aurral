import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const albumPage = (page, title) => ({
  kind: "albums",
  albums: [{ id: page, title, trackCount: 1 }],
  page,
  pageSize: 100,
  total: 150,
});

test("library paging keeps the current page visible until the next one arrives", async ({ page }) => {
  let releaseSecondPage;
  const secondPageHeld = new Promise((resolve) => { releaseSecondPage = resolve; });
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (path === "/health/bootstrap") {
      return json({ authRequired: false, onboardingRequired: false, lidarrConfigured: true });
    }
    if (path === "/health") return json({ lidarrConfigured: true });
    if (path === "/library/canonical" && url.searchParams.get("kind") === "albums") {
      if (url.searchParams.get("page") === "2") {
        await secondPageHeld;
        return json(albumPage(2, "Second Page Album"));
      }
      return json(albumPage(1, "First Page Album"));
    }
    if (path === "/library/favorites" || path === "/settings") return json({});
    return json([]);
  });

  await page.goto("/library/albums");
  const main = page.locator("main");
  await expect(main.getByText("First Page Album", { exact: true })).toBeVisible();

  await main.getByRole("button", { name: "Next page" }).click();
  await expect(main.locator("[aria-busy=true]")).toContainText("First Page Album");

  releaseSecondPage();
  await expect(main.getByText("Second Page Album", { exact: true })).toBeVisible();
  await expect(main.getByText("First Page Album", { exact: true })).toHaveCount(0);
  await expect(main.locator("[aria-busy=true]")).toHaveCount(0);
});
