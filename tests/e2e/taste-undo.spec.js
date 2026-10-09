import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

const artists = ["A", "B", "C"].map((letter) => ({
  id: `taste-undo-${letter.toLowerCase()}`,
  name: `Taste Undo ${letter}`,
  tags: [],
  genres: [],
}));

async function fixture(page) {
  const state = { feedback: [], writes: [] };
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/health/bootstrap") return json({ authRequired: false, onboardingRequired: false });
    if (path === "/discover") return json({ recommendations: artists, configured: true });
    if (path === "/users/me/discover-layout") return json({ layout: [] });
    if (path === "/discover/feedback" && request.method() === "GET") return json({ feedback: state.feedback });
    if (path === "/discover/feedback" && request.method() === "POST") {
      const body = request.postDataJSON();
      state.writes.push({ path, body });
      const entry = { ...body, id: `feedback-${state.writes.length}`, createdAt: new Date().toISOString() };
      state.feedback = [entry, ...state.feedback];
      return json({ success: true, feedback: entry, feedbackList: state.feedback });
    }
    if (path === "/discover/feedback/restore") {
      const body = request.postDataJSON();
      state.writes.push({ path, body });
      state.feedback = [...body.entries, ...state.feedback.filter((entry) => !body.removeIds.includes(entry.id))];
      return json({ success: true, feedbackList: state.feedback });
    }
    if (path.endsWith("/cover")) return json({ images: [] });
    if (path === "/settings") return json({});
    if (path === "/library/favorites") return json({});
    return json([]);
  });
  return state;
}

test("blocking an artist hides its card at once and Undo brings it back in place", async ({ page }) => {
  const state = await fixture(page);
  const names = () => page.getByText(/^Taste Undo [ABC]$/).filter({ visible: true }).allInnerTexts();
  await page.goto("/discover");
  await expect.poll(names).toEqual(["Taste Undo A", "Taste Undo B", "Taste Undo C"]);

  await page.getByRole("button", { name: "Artist options for Taste Undo B", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Block artist", exact: true }).click();
  await expect.poll(names).toEqual(["Taste Undo A", "Taste Undo C"]);

  const toast = page.locator(".app-toast").filter({
    hasText: "Blocked Taste Undo B from recommendations and playlist downloads",
  });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(names).toEqual(["Taste Undo A", "Taste Undo B", "Taste Undo C"]);
  await expect.poll(() => state.writes.map((write) => write.path)).toEqual([
    "/discover/feedback",
    "/discover/feedback/restore",
  ]);
  expect(state.writes[1].body).toEqual({ removeIds: ["feedback-1"], entries: [] });
  expect(state.feedback).toEqual([]);
});
