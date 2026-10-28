import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { contrastRatio, hexToOklch } from "../../frontend/src/utils/themeColor.ts";

const APP_ORIGIN = "https://aurral.example";
const CORS_HOSTS = new Set(["https://assets.fanart.tv"]);
const RED = [200, 40, 40, 255];
const fill = (color: number[]) => () => color;

function isRed(color: string | null) {
  assert.ok(color);
  return Number.parseInt(color.slice(1, 3), 16) > Number.parseInt(color.slice(5, 7), 16);
}

async function loadImageColors(
  t: import("vite-plus/test").TestContext,
  {
    cacheImage,
    apiBase = "/api",
    paint = fill(RED),
  }: {
    cacheImage: (src: string) => Promise<{ status: number; body: unknown }>;
    apiBase?: string;
    paint?: (x: number, y: number, width: number, height: number) => number[];
  },
) {
  const previousApiUrl = process.env.VITE_API_URL;
  if (apiBase === "/api") delete process.env.VITE_API_URL;
  else process.env.VITE_API_URL = apiBase;
  vi.resetModules();
  const cacheRequests: string[] = [];
  let loadedImage: FakeImage;

  vi.stubGlobal("window", { location: { href: `${APP_ORIGIN}/library`, origin: APP_ORIGIN } });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${apiBase}/image-proxy`);
    assert.equal(init?.method, "POST");
    const { src } = JSON.parse(String(init?.body));
    cacheRequests.push(src);
    const result = await cacheImage(src);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
  const isReadable = (image: FakeImage) => {
    const source = new URL(image.currentSrc, `${APP_ORIGIN}/`);
    return (
      source.origin === APP_ORIGIN ||
      (CORS_HOSTS.has(source.origin) && image.crossOrigin === "anonymous")
    );
  };
  class FakeImage {
    currentSrc = "";
    crossOrigin: string | null = null;
    onload: (() => void) | null = null;
    onerror: ((error: Error) => void) | null = null;
    set src(value: string) {
      this.currentSrc = value;
      loadedImage = this;
      queueMicrotask(() =>
        isReadable(this) ? this.onload?.() : this.onerror?.(new Error("CORS request blocked")),
      );
    }
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", {
    createElement: () => ({
      getContext: () => ({
        drawImage() {},
        getImageData(_x: number, _y: number, width: number, height: number) {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 0; index < data.length; index += 4) {
            const pixel = index / 4;
            data.set(paint(pixel % width, Math.floor(pixel / width), width, height), index);
          }
          return { data };
        },
      }),
    }),
  });
  t.onTestFinished(async () => {
    vi.unstubAllGlobals();
    if (previousApiUrl === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previousApiUrl;
  });

  const module = await import("../../frontend/src/utils/imageColors.ts");
  return { ...module, cacheRequests, loadedImage: () => loadedImage };
}

test("covers from hosts without CORS are read through Aurral's same-origin copy", async (t) => {
  const source = "https://imagecache.lidarr.audio/v1/caa/release/image.jpg";
  const localCopy = `/api/image-proxy/${"a".repeat(64)}.webp`;
  const colors = await loadImageColors(t, {
    cacheImage: async () => ({ status: 200, body: { url: localCopy } }),
  });

  const accent = await colors.extractArtworkAccent(source);
  assert.ok(accent != null);
  const wash = await colors.extractArtworkWash(source);
  assert.ok(wash != null);

  assert.match(accent, /^#[\da-f]{6}$/);
  assert.ok(isRed(accent), `${accent} is red`);
  assert.ok(isRed(wash.dark), `${wash.dark} is red`);
  assert.ok(isRed(wash.light), `${wash.light} is red`);
  assert.equal(colors.loadedImage().currentSrc, localCopy);
  assert.deepEqual(colors.cacheRequests, [source]);
});

test("same-origin cover copies load under the app's API base path", async (t) => {
  const source = "https://images.lidarr.audio/cover.jpg";
  const key = "c".repeat(64);
  const colors = await loadImageColors(t, {
    apiBase: "/aurral/api",
    cacheImage: async () => ({ status: 200, body: { url: `/api/image-proxy/${key}.webp` } }),
  });

  const accent = await colors.extractArtworkAccent(source);

  assert.ok(isRed(accent), `${accent} is red`);
  assert.equal(colors.loadedImage().currentSrc, `/aurral/api/image-proxy/${key}.webp`);
});

test("covers from CORS hosts are read directly without a server copy", async (t) => {
  const source = "https://assets.fanart.tv/fanart/cover.jpg";
  const colors = await loadImageColors(t, {
    cacheImage: async () => assert.fail("CORS covers need no copy"),
  });

  const accent = await colors.extractArtworkAccent(source);

  assert.ok(isRed(accent), `${accent} is red`);
  assert.equal(colors.loadedImage().currentSrc, source);
  assert.deepEqual(colors.cacheRequests, []);
});

test("same-origin covers are read without asking the server for a copy", async (t) => {
  const source = `/api/image-proxy/${"b".repeat(64)}.webp`;
  const colors = await loadImageColors(t, {
    cacheImage: async () => assert.fail("same-origin covers need no copy"),
  });

  const accent = await colors.extractArtworkAccent(source);

  assert.ok(isRed(accent), `${accent} is red`);
  assert.deepEqual([...colors.cacheRequests], []);
});

const source = `/api/image-proxy/${"d".repeat(64)}.webp`;
const noCopy = async () => assert.fail("same-origin covers need no copy");
const isRedHue = (color: ReturnType<typeof hexToOklch>) =>
  color !== null && (color.h < 40 || color.h > 340);

test("a mostly gray cover with a strong red region washes red instead of gray-pink", async (t) => {
  const colors = await loadImageColors(t, {
    cacheImage: noCopy,
    paint: (x, _y, width) => (x < width * 0.3 ? [210, 25, 30, 255] : [128, 128, 128, 255]),
  });

  const wash = await colors.extractArtworkWash(source);
  assert.ok(wash != null);

  for (const tone of [wash.dark, wash.light]) {
    const color = hexToOklch(tone);
    assert.ok(isRedHue(color), `${tone} has a red hue`);
    assert.ok(color.c > 0.08, `${tone} is vivid, not gray-pink`);
  }
});

test("a grayscale cover washes neutral", async (t) => {
  const colors = await loadImageColors(t, {
    cacheImage: noCopy,
    paint: (x, y) => {
      const value = 20 + (((x + y) * 3) % 220);
      return [value, value, value, 255];
    },
  });

  const wash = await colors.extractArtworkWash(source);
  assert.ok(wash != null);

  for (const tone of [wash.dark, wash.light]) {
    assert.ok(hexToOklch(tone).c < 0.02, `${tone} is neutral`);
  }
});

test("washes keep theme text readable even over pale or deep artwork", async (t) => {
  const pale = await loadImageColors(t, { cacheImage: noCopy, paint: fill([255, 244, 140, 255]) });
  const paleWash = await pale.extractArtworkWash(source);
  const deep = await loadImageColors(t, { cacheImage: noCopy, paint: fill([12, 18, 96, 255]) });
  const deepWash = await deep.extractArtworkWash(source);

  for (const wash of [paleWash, deepWash]) {
    assert.ok(wash);
    assert.ok(contrastRatio(wash.dark, "#ffffff") >= 4.5, `white text reads over ${wash.dark}`);
    assert.ok(contrastRatio(wash.light, "#171717") >= 4.5, `dark text reads over ${wash.light}`);
  }
});

test("covers that can't be read leave no wash", async (t) => {
  const colors = await loadImageColors(t, {
    cacheImage: noCopy,
    paint: fill([0, 0, 0, 0]),
  });

  assert.equal(await colors.extractArtworkWash(source), null);
});
