import { expect, test } from "@playwright/test";

const ARTIST_COUNT = 250;
const artistName = (number) => `Artist ${String(number).padStart(3, "0")}`;
const allArtists = Array.from({ length: ARTIST_COUNT }, (_, index) => ({
  id: `e2e-view-state-${index + 1}`,
  name: artistName(index + 1),
}));

test.beforeEach(async ({ page }) => {
  await page.route("**/api/library/canonical?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("kind") !== "artists" || params.get("artistId")) return route.fallback();
    const query = String(params.get("query") || "").toLocaleLowerCase();
    let artists = allArtists.filter((artist) => artist.name.toLocaleLowerCase().includes(query));
    if (params.get("sort") === "newest") artists = [...artists].reverse();
    if (params.get("direction") === "desc") artists = [...artists].reverse();
    const page = Number(params.get("page") || 1);
    const pageSize = Number(params.get("pageSize"));
    const items = artists.slice((page - 1) * pageSize, page * pageSize);
    return route.fulfill({
      json: {
        kind: "artists",
        page,
        pageSize,
        total: artists.length,
        hasMore: page * pageSize < artists.length,
        items,
        artists: items,
        albums: [],
        tracks: [],
        genres: [],
      },
    });
  });
});

test("library keeps its page, sort, view, and search in the URL across Back and reload", async ({ page }) => {
  const main = page.locator("main.app-main");
  const pageLabel = page.getByText(/^Page \d+ of \d+$/);
  const search = () => new URL(page.url()).search;

  await page.goto("/library/artists");
  await expect(pageLabel).toHaveText("Page 1 of 3");
  expect(search()).toBe("");

  await page.getByRole("combobox", { name: "Sort artists" }).selectOption("newest");
  await expect.poll(search).toBe("?sort=newest");
  await expect(page.getByRole("button", { name: `Open ${artistName(250)}` })).toBeVisible();

  await page.getByRole("button", { name: "Next page" }).click();
  await expect.poll(search).toBe("?sort=newest&page=2");
  await expect(pageLabel).toHaveText("Page 2 of 3");

  await page.getByRole("button", { name: "List view" }).click();
  await expect.poll(search).toBe("?sort=newest&page=2&view=list");

  await main.evaluate((node) => node.scrollTo({ top: 900 }));
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(900);
  const target = page.getByRole("button", { name: `Open ${artistName(120)}` });
  await target.evaluate((button) => button.click());
  await expect(page).toHaveURL(/\/library\/artist\/e2e-view-state-120$/);

  await page.goBack();
  await expect.poll(search).toBe("?sort=newest&page=2&view=list");
  await expect(pageLabel).toHaveText("Page 2 of 3");
  await expect(page.getByRole("combobox", { name: "Sort artists" })).toHaveValue("newest");
  await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(900);

  const gridView = page.getByRole("button", { name: "Grid view" });
  await gridView.evaluate((button) => button.click());
  await expect.poll(search).toBe("?sort=newest&page=2");
  await expect(gridView).toHaveAttribute("aria-pressed", "true");
  expect(await main.evaluate((node) => node.scrollTop)).toBe(900);

  await page.getByRole("button", { name: "Search artists" }).click();
  await page.getByRole("searchbox", { name: "Search artists" }).pressSequentially("Artist 1");
  await expect.poll(search).toBe("?sort=newest&q=Artist+1");
  await expect(pageLabel).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search artists" })).toHaveValue("Artist 1");
  await expect(page.getByRole("button", { name: `Open ${artistName(199)}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Open ${artistName(250)}` })).toHaveCount(0);

  await page.goBack();
  await expect.poll(search).toBe("?sort=newest");
  await expect(page.getByRole("searchbox", { name: "Search artists" })).toHaveCount(0);
  await expect(pageLabel).toHaveText("Page 1 of 3");

  await page.getByRole("combobox", { name: "Sort artists" }).selectOption("name");
  await expect.poll(search).toBe("");
  await expect(page.getByRole("button", { name: `Open ${artistName(1)}` })).toBeVisible();
});
