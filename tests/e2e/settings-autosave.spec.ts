import { expect, test, type Page } from "@playwright/test";
import type { AppSettings, SettingsUpdate } from "../../backend/db/helpers/settings.ts";
import { apiRequest, openApp, requireCredentials } from "./helpers.ts";

requireCredentials();

type HeldSave = {
  body: { inbox: NonNullable<SettingsUpdate["inbox"]> };
  released: Promise<void>;
  release: () => void;
};

async function holdSettingsSaves(page: Page) {
  const saves: HeldSave[] = [];
  let inFlight = 0;
  let overlapped = false;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const save = { body: route.request().postDataJSON() } as HeldSave;
    save.released = new Promise((resolve) => {
      save.release = resolve;
    });
    saves.push(save);
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
    await save.released;
    try {
      await route.continue();
    } finally {
      inFlight -= 1;
    }
  });
  return {
    saves,
    overlapped: () => overlapped,
    releaseAll: () => saves.forEach((save) => save.release()),
  };
}

async function readInbox(page: Page): Promise<Partial<AppSettings["inbox"]>> {
  const response = await apiRequest(page, "/api/settings");
  expect(response.ok).toBe(true);
  return response.body?.inbox || {};
}

async function restoreInbox(page: Page, inbox: Partial<AppSettings["inbox"]>) {
  await page.unrouteAll({ behavior: "wait" });
  const restored = await apiRequest(page, "/api/settings", { method: "POST", body: { inbox } });
  expect(restored.ok).toBe(true);
}

test("a change made back to the saved value during a save is still saved", async ({ page }) => {
  await openApp(page);
  const originalInbox = await readInbox(page);
  const original = originalInbox.recommendedNews === true;

  try {
    await page.goto("/settings/connect");
    const toggle = page.getByLabel("Show recommended artist news in inbox");
    await expect(toggle).toBeVisible();
    const saves = await holdSettingsSaves(page);

    await toggle.click();
    await expect.poll(() => saves.saves.length).toBe(1);
    expect(saves.saves[0].body.inbox.recommendedNews).toBe(!original);

    await toggle.click();
    await expect(toggle).toBeChecked({ checked: original });
    await page.waitForTimeout(800);
    expect(saves.saves).toHaveLength(1);

    saves.saves[0].release();
    await expect.poll(() => saves.saves.length).toBe(2);
    expect(saves.saves[1].body.inbox.recommendedNews).toBe(original);
    saves.releaseAll();

    await expect.poll(async () => (await readInbox(page)).recommendedNews === true).toBe(original);
    expect(saves.overlapped()).toBe(false);
  } finally {
    await restoreInbox(page, originalInbox);
  }
});

test("changes made during a save wait for it and are saved after it", async ({ page }) => {
  await openApp(page);
  const originalInbox = await readInbox(page);
  const recommended = originalInbox.recommendedNews === true;
  const news = originalInbox.news !== false;

  try {
    await page.goto("/settings/connect");
    const recommendedToggle = page.getByLabel("Show recommended artist news in inbox");
    const newsToggle = page.getByLabel("Show library artist news in inbox");
    await expect(recommendedToggle).toBeVisible();
    const saves = await holdSettingsSaves(page);

    await recommendedToggle.click();
    await expect.poll(() => saves.saves.length).toBe(1);

    await newsToggle.click();
    await page.waitForTimeout(800);
    expect(saves.saves).toHaveLength(1);

    saves.saves[0].release();
    await expect.poll(() => saves.saves.length).toBe(2);
    expect(saves.saves[1].body.inbox).toMatchObject({ recommendedNews: !recommended, news: !news });
    saves.releaseAll();

    await expect
      .poll(async () => {
        const inbox = await readInbox(page);
        return { recommendedNews: inbox.recommendedNews === true, news: inbox.news !== false };
      })
      .toEqual({ recommendedNews: !recommended, news: !news });
    expect(saves.overlapped()).toBe(false);
  } finally {
    await restoreInbox(page, originalInbox);
  }
});
