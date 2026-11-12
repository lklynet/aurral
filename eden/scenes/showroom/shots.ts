import type { Locator, Page } from "playwright-core";

// Every screenshot the README, docs, and aurral.org use, taken in the showroom and
// written to web/screenshots/<name>.webp. A shot only looks: whatever it shows is set
// up by the showroom seed. `vary` marks a part of the page Aurral shuffles on every
// load, which is captured as it is but never by itself makes a shot count as changed.
export type Shot = {
  name: string;
  path: string;
  user?: "admin" | "listener";
  light?: boolean;
  prepare?: (page: Page) => Promise<void>;
  vary?: (page: Page) => Locator;
};

const BAD_BUNNY = "/artist/89aa5ecb-59ad-46f5-b3eb-2d424e941f19";
const INDIE_SLEAZE = "/discover/playlists/deezer/9008";

export const SHOTS: Shot[] = [
  { name: "discover", path: "/" },
  { name: "discover-2", path: "/", user: "listener" },
  {
    name: "discover-customize",
    path: "/",
    prepare: (page) => page.getByRole("button", { name: "Customize Discover" }).click(),
  },
  {
    name: "inbox",
    path: "/",
    prepare: (page) => page.getByRole("button", { name: /^Inbox/ }).click(),
  },
  {
    name: "library",
    path: "/library",
    vary: (page) =>
      page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "Explore", exact: true }) }),
  },
  { name: "playback", path: BAD_BUNNY },
  { name: "playlists", path: INDIE_SLEAZE },
  { name: "search", path: "/search?q=misfits" },
  { name: "shows", path: "/shows" },
  {
    name: "flow-editor",
    path: "/flows",
    prepare: async (page) => {
      await page.getByRole("link", { name: "Release Radar" }).first().click();
      await page.getByRole("button", { name: "Edit flow" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  { name: "themes", path: "/?settings=appearance", light: true },
  { name: "profile-listening", path: "/?settings=listening" },
  { name: "settings-user", path: "/?settings=users" },
];
