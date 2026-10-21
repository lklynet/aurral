import { expect, test, type Page } from "@playwright/test";
import { requireCredentials } from "./helpers.ts";

requireCredentials();

const apiPath = (path: string) => (url: URL) => url.pathname === `/api${path}`;

async function openImport(page: Page) {
  await page.goto("/playlists");
  await expect(page.getByRole("heading", { level: 1, name: /^Playlists\b/ })).toBeVisible();
  await page.getByRole("button", { name: "Create playlist" }).click();
  await page.getByRole("menuitem", { name: "Import playlist" }).click();
  const dialog = page.getByRole("dialog", { name: "Import playlist" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("Last.fm import starts from the profile username and can switch accounts", async ({
  page,
}) => {
  const stationRequests: (string | null)[] = [];
  let importPayload: unknown;

  await page.route(apiPath("/playlists/import/spotify/status"), (route) =>
    route.fulfill({ json: { connected: false, displayName: null } }),
  );
  await page.route(apiPath("/users/me/listening-history"), (route) =>
    route.fulfill({
      json: { listenHistoryProvider: "lastfm", listenHistoryUsername: "profile-user" },
    }),
  );
  await page.route(apiPath("/playlists/import/lastfm/playlists"), (route) => {
    const username = new URL(route.request().url()).searchParams.get("username");
    stationRequests.push(username);
    if (username === "missing-user") {
      return route.fulfill({ status: 404, json: { message: "Last.fm user not found" } });
    }
    return route.fulfill({
      json: {
        playlists: [
          {
            id: `${username}-library`,
            name: `${username} library`,
            trackCount: 25,
            sourceType: "lastfm-station",
          },
        ],
      },
    });
  });
  await page.route(apiPath("/playlists/import/lastfm/preview"), (route) =>
    route.fulfill({
      json: {
        trackCount: 3,
        skipped: 1,
        previewTracks: [{ artistName: "Artist L", trackName: "Track L" }],
      },
    }),
  );
  await page.route(apiPath("/playlists/import/lastfm"), (route) => {
    importPayload = route.request().postDataJSON();
    return route.fulfill({ json: { success: true } });
  });

  const dialog = await openImport(page);
  await dialog.getByRole("button", { name: "Last.fm", exact: true }).click();
  await expect(dialog.getByText("Signed in as")).toContainText("profile-user");
  await expect(dialog.getByRole("option", { name: /profile-user library/ })).toBeVisible();

  await dialog.getByRole("button", { name: "Change", exact: true }).click();
  const usernameInput = dialog.getByLabel("Last.fm username");
  await expect(usernameInput).toHaveValue("");

  await usernameInput.fill("missing-user");
  await usernameInput.press("Enter");
  await expect(page.getByText("Last.fm user not found")).toBeVisible();
  await expect(usernameInput).toHaveValue("missing-user");

  await usernameInput.fill("other-user");
  await dialog.getByRole("button", { name: "Load stations" }).click();
  await expect(dialog.getByText("Signed in as")).toContainText("other-user");
  await dialog.getByRole("option", { name: /other-user library/ }).click();
  await expect(dialog.getByText("3 importable")).toBeVisible();
  await expect(dialog.getByLabel("Name in Aurral")).toHaveValue("other-user library");

  await dialog.getByRole("button", { name: "Import playlist", exact: true }).click();
  await expect
    .poll(() => importPayload)
    .toMatchObject({
      playlistId: "other-user-library",
      username: "other-user",
      externalName: "other-user library",
      name: "other-user library",
    });
  expect(stationRequests).toEqual(["profile-user", "missing-user", "other-user"]);
});

test("a Spotify sign-in that expired returns the import to the connect step", async ({ page }) => {
  await page.route(apiPath("/playlists/import/spotify/status"), (route) =>
    route.fulfill({ json: { connected: true, displayName: "Spotify Tester" } }),
  );
  await page.route(apiPath("/playlists/import/spotify/playlists"), (route) =>
    route.fulfill({
      json: {
        user: "Spotify Tester",
        playlists: [{ id: "road-trip", name: "Road trip", trackCount: 12 }],
      },
    }),
  );
  await page.route(apiPath("/playlists/import/spotify/preview"), (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: "Spotify authentication required",
        code: "SPOTIFY_AUTH_REQUIRED",
        message: "Reconnect Spotify to continue",
      },
    }),
  );

  const dialog = await openImport(page);
  await expect(dialog.getByText("Signed in as")).toContainText("Spotify Tester");
  await dialog.getByRole("option", { name: /Road trip/ }).click();

  await expect(page.getByText("Reconnect Spotify to continue")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Connect Spotify" })).toBeVisible();
  await expect(dialog.getByText("Road trip")).toHaveCount(0);
});
