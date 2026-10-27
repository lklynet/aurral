import { requireFixture } from "./playlists/fixtures.ts";
import { listeningAddress } from "./helpers/backendTestHarness.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Hono } from "hono";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import type { AppEnv } from "../backend/middleware/requestUser.ts";
import { createIsolatedStateDir } from "./helpers/backendTestHarness.ts";
import { listen } from "./helpers/honoApp.ts";

test(
  "cached artwork remains available while a remote refresh fails",
  { timeout: 10000 },
  async () => {
    const state = await createIsolatedStateDir("cached-image-refresh");
    const previousDataDir = process.env.AURRAL_DATA_DIR;
    const originalFetch = global.fetch;
    const refreshStarted = Promise.withResolvers<void>();
    const refreshGate = Promise.withResolvers<void>();
    let localStarted = Promise.withResolvers<void>();
    let server:
      | import("node:http").Server<
          typeof import("node:http").IncomingMessage,
          typeof import("node:http").ServerResponse
        >
      | undefined;
    let refresh: Promise<void> | undefined;
    process.env.AURRAL_DATA_DIR = state.dataDir;
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      global.fetch = async () => new Response(png, { headers: { "content-type": "image/png" } });
      vi.resetModules();
      const seed = await import("../backend/services/imageProxyService.ts");
      const sourceUrl = "https://images.example/cached-refresh.png";
      const cached = await seed.warmImageProxy(sourceUrl);
      const legacyPath = cached.imagePath.replace(/\.webp$/, ".png");
      await fs.writeFile(legacyPath, png);
      await fs.writeFile(
        path.join(state.dataDir, "image-proxy", `${cached.cacheKey}.json`),
        JSON.stringify({
          ...cached.meta,
          extension: "png",
          contentType: "image/png",
          size: png.length,
          fetchedAt: 0,
        }),
      );
      await fs.unlink(cached.imagePath);
      vi.resetModules();
      const { warmImageProxy } = await import("../backend/services/imageProxyService.ts");
      const { default: imageProxy } = await import("../backend/routes/imageProxy.ts");
      server = await listen(
        new Hono<AppEnv>()
          .use(async (_c, next) => {
            localStarted.resolve();
            await next();
          })
          .route("/api", imageProxy),
      );
      const base = `http://127.0.0.1:${listeningAddress(requireFixture(server)).port}`;
      const missing = await originalFetch(
        `${base}/api/image-proxy/${randomBytes(32).toString("hex")}.webp`,
      );
      assert.equal(missing.status, 404);
      await missing.arrayBuffer();
      global.fetch = async () => {
        refreshStarted.resolve();
        await refreshGate.promise;
        throw new Error("remote refresh unavailable");
      };
      refresh = assert.rejects(warmImageProxy(sourceUrl), /remote refresh unavailable/);
      await refreshStarted.promise;
      localStarted = Promise.withResolvers<void>();
      const local = originalFetch(`${base}${cached.localUrl}`);
      await localStarted.promise;
      await new Promise(setImmediate);
      refreshGate.resolve();
      await refresh;
      const response = await local;
      assert.equal(response.status, 200, "a failed refresh must not hide an existing cached image");
      assert.equal(response.headers.get("content-type"), "image/webp");
      assert.ok((await response.arrayBuffer()).byteLength > 0);
      assert.ok(
        (await fs.readdir(path.join(state.dataDir, "image-proxy"))).some((name: string) =>
          name.endsWith(".webp"),
        ),
      );
    } finally {
      refreshGate.resolve();
      await refresh;
      global.fetch = originalFetch;
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
      else process.env.AURRAL_DATA_DIR = previousDataDir;
      await fs.rm(state.baseDir, { recursive: true, force: true });
    }
  },
);

test(
  "image bursts limit upstream work, share duplicates, and release slots after failures",
  { timeout: 10000 },
  async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-image-burst-"));
    const previousDataDir = process.env.AURRAL_DATA_DIR;
    const originalFetch = global.fetch;
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let requests: Promise<PromiseSettledResult<unknown>[]> | undefined;
    process.env.AURRAL_DATA_DIR = dataDir;
    try {
      vi.resetModules();
      const { warmImageProxy } = await import("../backend/services/imageProxyService.ts");
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const calls: string[] = [];
      let fail = true;
      global.fetch = async (url) => {
        calls.push(String(url));
        if (calls.length === 2) started.resolve();
        await gate.promise;
        if (String(url).endsWith("/fail.png") && fail) throw new Error("upstream unavailable");
        return new Response(png, { headers: { "content-type": "image/png" } });
      };
      const urls = ["fail", "second", "third", "fourth", "fail"].map(
        (name) => `https://images.example/${name}.png`,
      );
      requests = Promise.allSettled(urls.map((url) => warmImageProxy(url)));
      await started.promise;
      await new Promise(setImmediate);
      assert.equal(calls.length, 2, "queued requests must not hold source image bytes");
      gate.resolve();
      const results = await requests;
      assert.deepEqual(
        results.map((result) => result.status),
        ["rejected", "fulfilled", "fulfilled", "fulfilled", "rejected"],
      );
      assert.equal(calls.filter((url: string) => url.endsWith("/fail.png")).length, 1);
      fail = false;
      const retried = await warmImageProxy(urls[0]);
      assert.equal(retried.meta.contentType, "image/webp");
      assert.equal(calls.length, 5);
      await warmImageProxy(urls[1]);
      assert.equal(calls.length, 5, "cached artwork must not be fetched again");
    } finally {
      gate.resolve();
      await requests;
      global.fetch = originalFetch;
      if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
      else process.env.AURRAL_DATA_DIR = previousDataDir;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  },
);

test("image proxy caches one library-sized webp instead of full-resolution sources", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-image-library-"));
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  const originalFetch = global.fetch;
  process.env.AURRAL_DATA_DIR = dataDir;
  try {
    const sharp = (await import("sharp")).default;
    vi.resetModules();
    const { warmImageProxy } = await import("../backend/services/imageProxyService.ts");
    const source = await sharp({
      create: {
        width: 2000,
        height: 1600,
        channels: 3,
        background: { r: 40, g: 80, b: 120 },
      },
    })
      .png()
      .toBuffer();

    global.fetch = async () => new Response(source, { headers: { "content-type": "image/png" } });

    const cached = await warmImageProxy("https://images.example/large-library.png");
    assert.equal(cached.meta.contentType, "image/webp");
    assert.ok(requireFixture(cached.meta.size) <= 150 * 1024);

    const meta = await sharp(cached.imagePath).metadata();
    assert.equal(meta.format, "webp");
    assert.ok(Math.max(meta.width, meta.height) <= 512);
  } finally {
    global.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
    else process.env.AURRAL_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("image proxy serves cached images from hidden worktree paths", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), ".aurral-image-hidden-"));
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  const originalFetch = global.fetch;
  let server:
    | import("node:http").Server<
        typeof import("node:http").IncomingMessage,
        typeof import("node:http").ServerResponse
      >
    | undefined;
  process.env.AURRAL_DATA_DIR = dataDir;
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    global.fetch = async () => new Response(png, { headers: { "content-type": "image/png" } });

    vi.resetModules();
    const { warmImageProxy } = await import("../backend/services/imageProxyService.ts");
    const { default: imageProxy } = await import("../backend/routes/imageProxy.ts");
    const cached = await warmImageProxy("https://images.example/hidden-path.png");
    global.fetch = originalFetch;

    server = await listen(new Hono<AppEnv>().route("/api", imageProxy));

    const response = await fetch(
      `http://127.0.0.1:${listeningAddress(requireFixture(server)).port}${cached.localUrl}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  } finally {
    global.fetch = originalFetch;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
    else process.env.AURRAL_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("image proxy cache prunes oldest entries over the size cap", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-image-cap-"));
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  const previousMaxBytes = process.env.AURRAL_IMAGE_PROXY_MAX_BYTES;
  const originalFetch = global.fetch;
  process.env.AURRAL_DATA_DIR = dataDir;
  process.env.AURRAL_IMAGE_PROXY_MAX_BYTES = String(200 * 1024);
  try {
    const sharp = (await import("sharp")).default;
    vi.resetModules();
    const { warmImageProxy, getImageProxyCacheSizeBytes } =
      await import("../backend/services/imageProxyService.ts");
    const noise = Buffer.alloc(512 * 512 * 3);
    for (let i = 0; i < noise.length; i += 1) {
      noise[i] = (i * 37 + (i % 251) * 13) % 256;
    }

    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < noise.length; j += 97) {
        noise[j] = (noise[j] + i + 1) % 256;
      }
      const variant = await sharp(noise, {
        raw: { width: 512, height: 512, channels: 3 },
      })
        .png({ compressionLevel: 0 })
        .toBuffer();
      global.fetch = async () =>
        new Response(variant, { headers: { "content-type": "image/png" } });
      await warmImageProxy(`https://images.example/cap-${i}.png`);
    }

    const size = await getImageProxyCacheSizeBytes();
    assert.ok(size <= 200 * 1024, `cache size ${size} exceeded 200KiB cap`);
    const files = await fs.readdir(path.join(dataDir, "image-proxy"));
    const images = files.filter((name: string) => name.endsWith(".webp"));
    assert.ok(images.length >= 1);
    assert.ok(images.length < 6);
  } finally {
    global.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
    else process.env.AURRAL_DATA_DIR = previousDataDir;
    if (previousMaxBytes === undefined) delete process.env.AURRAL_IMAGE_PROXY_MAX_BYTES;
    else process.env.AURRAL_IMAGE_PROXY_MAX_BYTES = previousMaxBytes;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
