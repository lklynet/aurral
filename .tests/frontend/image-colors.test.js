import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";
import { contrastRatio, hexToOklch } from "../../frontend/src/utils/themeColor.js";

const APP_ORIGIN = "https://aurral.example";
const CORS_HOSTS = new Set(["https://assets.fanart.tv"]);
const RED = [200, 40, 40, 255];
const fill = (color) => () => color;

function isRed(color) {
  return Number.parseInt(color.slice(1, 3), 16) > Number.parseInt(color.slice(5, 7), 16);
}

async function loadImageColors(t, { cacheImage, apiBase = "/api", paint = fill(RED) }) {
  const previousApiUrl = process.env.VITE_API_URL;
  if (apiBase === "/api") delete process.env.VITE_API_URL;
  else process.env.VITE_API_URL = apiBase;
  const vite = await startFrontendServer();
  const previous = {
    document: globalThis.document,
    Image: globalThis.Image,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  const cacheRequests = [];
  let loadedImage;

  globalThis.window = { location: { href: `${APP_ORIGIN}/library`, origin: APP_ORIGIN } };
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${apiBase}/image-proxy`);
    assert.equal(init.method, "POST");
    const { src } = JSON.parse(init.body);
    cacheRequests.push(src);
    const result = await cacheImage(src);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.Image = class {
    set src(value) {
      this.currentSrc = value;
      loadedImage = this;
      queueMicrotask(() => this.onload?.());
    }
  };
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        drawImage() {},
        getImageData(_x, _y, width, height) {
          const source = new URL(loadedImage.currentSrc, `${APP_ORIGIN}/`);
          const readable =
            source.origin === APP_ORIGIN ||
            (CORS_HOSTS.has(source.origin) && loadedImage.crossOrigin === "anonymous");
          if (!readable) throw new Error("Canvas is tainted");
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 0; index < data.length; index += 4) {
            const pixel = index / 4;
            data.set(paint(pixel % width, Math.floor(pixel / width), width, height), index);
          }
          return { data };
        },
      }),
    }),
  };
  t.after(async () => {
    Object.assign(globalThis, previous);
    if (previousApiUrl === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previousApiUrl;
    await vite.close();
  });

  const module = await vite.ssrLoadModule(`/src/utils/imageColors.js?test=${Date.now()}-${Math.random()}`);
  return { ...module, cacheRequests, loadedImage: () => loadedImage };
}

test("covers from hosts without CORS are read through Aurral's same-origin copy", async (t) => {
  const source = "https://imagecache.lidarr.audio/v1/caa/release/image.jpg";
  const localCopy = `/api/image-proxy/${"a".repeat(64)}.webp`;
  const colors = await loadImageColors(t, {
    cacheImage: async () => ({ status: 200, body: { url: localCopy } }),
  });

  const accent = await colors.extractArtworkAccent(source);
  const wash = await colors.extractArtworkWash(source);

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

test("covers still read directly from CORS hosts when Aurral can't cache them", async (t) => {
  const source = "https://assets.fanart.tv/fanart/cover.jpg";
  const colors = await loadImageColors(t, {
    cacheImage: async () => ({ status: 404, body: { error: "Image not found" } }),
  });

  const accent = await colors.extractArtworkAccent(source);

  assert.ok(isRed(accent), `${accent} is red`);
  assert.equal(colors.loadedImage().currentSrc, source);
});

test("same-origin covers are read without asking the server for a copy", async (t) => {
  const source = `/api/image-proxy/${"b".repeat(64)}.webp`;
  const colors = await loadImageColors(t, {
    cacheImage: async () => assert.fail("same-origin covers need no copy"),
  });

  const accent = await colors.extractArtworkAccent(source);

  assert.ok(isRed(accent), `${accent} is red`);
  assert.deepEqual(colors.cacheRequests, []);
});

const source = `/api/image-proxy/${"d".repeat(64)}.webp`;
const noCopy = async () => assert.fail("same-origin covers need no copy");
const isRedHue = ({ h }) => h < 40 || h > 340;

test("a mostly gray cover with a strong red region washes red instead of gray-pink", async (t) => {
  const colors = await loadImageColors(t, {
    cacheImage: noCopy,
    paint: (x, _y, width) => (x < width * 0.3 ? [210, 25, 30, 255] : [128, 128, 128, 255]),
  });

  const wash = await colors.extractArtworkWash(source);

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
      const value = 20 + ((x + y) * 3) % 220;
      return [value, value, value, 255];
    },
  });

  const wash = await colors.extractArtworkWash(source);

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
