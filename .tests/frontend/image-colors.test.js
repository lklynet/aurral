import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

const APP_ORIGIN = "https://aurral.example";
const CORS_HOSTS = new Set(["https://assets.fanart.tv"]);
const RED = [200, 40, 40, 255];

function isRed(color) {
  return Number.parseInt(color.slice(1, 3), 16) > Number.parseInt(color.slice(5, 7), 16);
}

async function loadImageColors(t, { cacheImage, apiBase = "/api" }) {
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
          for (let index = 0; index < data.length; index += 4) data.set(RED, index);
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
  const gradient = await colors.extractTwoToneGradientFromImage(source);

  assert.match(accent, /^#[\da-f]{6}$/);
  assert.ok(isRed(accent), `${accent} is red`);
  assert.notDeepEqual(gradient, colors.FALLBACK_GRADIENT);
  assert.ok(isRed(gradient.top), `${gradient.top} is red`);
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
