import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import sharp from "sharp";
import * as v from "valibot";
import { AurralApi } from "../../aurral.ts";
import { until } from "../../services/service.ts";
import { LISTENER, LOGIN, type Ports } from "../../state.ts";
import { DISCOVERY_TIMEOUT_MS, discoveryStatus } from "./seed.ts";
import { SHOTS, type Shot } from "./shots.ts";

const VIEWPORT = { width: 1920, height: 1080 };
const SCALE = 2;
const WEBP = { quality: 82, effort: 6 } as const;
// A pixel counts as changed past this much in any channel, and a screenshot is rewritten
// once this share of its pixels changed, so font smoothing and encoding noise do not
// churn files that look the same.
const CHANNEL_TOLERANCE = 24;
const CHANGED_SHARE = 0.001;

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  // Lazy images below the fold never load, so only the ones on screen are awaited.
  await page.evaluate(async () => {
    const { document, innerHeight, innerWidth } = globalThis;
    await document.fonts.ready;
    const onScreen = (image: HTMLImageElement) => {
      const box = image.getBoundingClientRect();
      return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
    };
    await Promise.all(
      Array.from(document.images)
        .filter((image) => !image.complete && onScreen(image))
        .map((image) => image.decode().catch(() => null)),
    );
  });
  await page.waitForLoadState("networkidle");
}

const discoverStatus = async (session: AurralApi) =>
  v.parse(discoveryStatus, await session.get("/discover/status"));

// Aurral refreshes a user's Discover on its own, some seconds after it starts or syncs
// listening history, and a shot taken meanwhile would show it loading. A shot is
// retaken until Discover stayed idle and unchanged for all of it.
async function takeWhileIdle(browser: Browser, session: AurralApi, shot: Shot) {
  for (;;) {
    await until(
      "Discover to settle",
      async () => !(await discoverStatus(session)).isUpdating,
      DISCOVERY_TIMEOUT_MS,
    );
    const before = await discoverStatus(session);
    await take(browser, session, shot);
    const capture = await take(browser, session, shot);
    const after = await discoverStatus(session);
    if (!after.isUpdating && after.lastUpdated === before.lastUpdated) return capture;
  }
}

// Rails scroll sideways past their section, so a varying part spans the full width.
type Band = { top: number; bottom: number };

async function differs(file: string, { png, varies }: Capture) {
  if (!existsSync(file)) return true;
  const decode = (input: Buffer | string) =>
    sharp(input).resize(VIEWPORT.width, VIEWPORT.height).removeAlpha().raw().toBuffer();
  const [before, after] = await Promise.all([decode(file), decode(png)]);
  const inVaried = (pixel: number) => {
    const y = Math.floor(pixel / VIEWPORT.width);
    return varies.some((band) => y >= band.top && y < band.bottom);
  };
  let changed = 0;
  for (let index = 0; index < before.length; index += 3) {
    if (inVaried(index / 3)) continue;
    if (
      Math.abs((before[index] ?? 0) - (after[index] ?? 0)) > CHANNEL_TOLERANCE ||
      Math.abs((before[index + 1] ?? 0) - (after[index + 1] ?? 0)) > CHANNEL_TOLERANCE ||
      Math.abs((before[index + 2] ?? 0) - (after[index + 2] ?? 0)) > CHANNEL_TOLERANCE
    ) {
      changed += 1;
    }
  }
  return changed / (before.length / 3) > CHANGED_SHARE;
}

// Takes every shot and rewrites only the ones that changed. Each page is opened once
// before its shot, so artwork Aurral makes or fetches on first view is there for it.
export async function captureShots(
  ports: Ports,
  outDir: string,
  only: ReadonlySet<string> = new Set(),
) {
  const sessions = { admin: new AurralApi(ports), listener: new AurralApi(ports) };
  await Promise.all([sessions.admin.login(LOGIN), sessions.listener.login(LISTENER)]);
  const shots = SHOTS.filter((shot) => only.size === 0 || only.has(shot.name));
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    for (const shot of shots) {
      const session = sessions[shot.user ?? "admin"];
      const capture = await takeWhileIdle(browser, session, shot);
      const file = path.join(outDir, `${shot.name}.webp`);
      if (!(await differs(file, capture))) {
        console.log(`${shot.name}: unchanged`);
        continue;
      }
      mkdirSync(outDir, { recursive: true });
      writeFileSync(file, await sharp(capture.png).webp(WEBP).toBuffer());
      written.push(shot.name);
      console.log(`${shot.name}: updated`);
    }
  } finally {
    await browser.close();
  }
  return written;
}

type Capture = { png: Buffer; varies: Band[] };

async function take(browser: Browser, session: AurralApi, shot: Shot): Promise<Capture> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: shot.light ? "light" : "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  try {
    await context.addInitScript(
      (token) => localStorage.setItem("auth_token", token),
      session.token ?? "",
    );
    const page = await context.newPage();
    await page.goto(`${session.base}${shot.path}`);
    await settle(page);
    if (shot.prepare) {
      await shot.prepare(page);
      await settle(page);
    }
    const png = await page.screenshot({ animations: "disabled", caret: "hide" });
    const box = shot.vary ? await shot.vary(page).boundingBox() : null;
    return { png, varies: box ? [{ top: box.y, bottom: box.y + box.height }] : [] };
  } finally {
    await context.close();
  }
}
