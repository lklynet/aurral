import { expect, test } from "@playwright/test";

test.skip(!process.env.AURRAL_LAB_PUBLIC_TLS, "These journeys need an Aurral Lab's simulated public services");

async function signIn(page) {
  await page.goto("/");
  await page.getByLabel("Username").fill(process.env.AUTH_USER);
  await page.getByLabel("Password").fill(process.env.AUTH_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Primary navigation")).toBeVisible();
}

const currentUser = (page) =>
  page.evaluate(async () => {
    const response = await fetch("/api/auth/me", { headers: { authorization: `Bearer ${localStorage.getItem("auth_token")}` } });
    return (await response.json()).user;
  });

test("SSO sign-in creates a member account through the identity provider", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with SSO" }).click();
  await page.getByRole("link", { name: "Continue as Lab SSO Member" }).click();
  await expect(page.getByLabel("Primary navigation")).toBeVisible();
  const user = await currentUser(page);
  expect(user.username).toBe("lab-sso-member");
  expect(user.role).toBe("user");
});

test("Spotify reconnects through its sign-in pages and lists every playlist", async ({ page }) => {
  await signIn(page);
  await page.goto("/playlists");
  await page.getByRole("button", { name: "Create playlist" }).click();
  await page.getByRole("menuitem", { name: "Import playlist" }).click();
  await expect(page.getByText("Signed in as")).toContainText("Lab Listener");

  await page.getByRole("button", { name: "Disconnect" }).click();
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Spotify" }).click();
  await (await popup).waitForEvent("close").catch(() => {});

  const playlists = page.getByRole("listbox", { name: "Spotify playlists" });
  await expect(playlists.getByRole("option", { name: /Lab Long Mix/ })).toBeVisible();
  await playlists.getByRole("option", { name: /Lab Long Mix/ }).click();
  await expect(page.getByText(/75 tracks/)).toBeVisible();
});

test("Last.fm relinks through its authorization page", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/playback");
  const linked = page.getByRole("switch", { name: "Last.fm — lab-listener" });
  const unlinked = page.getByRole("switch", { name: "Last.fm", exact: true });
  await expect(linked.or(unlinked)).toBeVisible();
  if (await linked.isVisible()) await linked.click();
  await expect(unlinked).not.toBeChecked();

  await unlinked.click();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Last.fm account" }).click();
  const popup = await popupPromise;
  await expect(popup.getByText("Last.fm connected.")).toBeVisible();
  await popup.close();
  await expect(page.getByRole("dialog", { name: "Last.fm scrobbling" }).getByRole("button", { name: "Relink Last.fm" })).toBeVisible();
});
