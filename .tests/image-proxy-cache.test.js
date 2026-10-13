import assert from "node:assert/strict";
import fs from "node:fs/promises";
import express from "express";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("image bursts limit upstream work, share duplicates, and release slots after failures", { timeout: 10000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-image-burst-"));
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  const originalFetch = global.fetch;
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let requests;
  process.env.AURRAL_DATA_DIR = dataDir;
  try {
    const { warmImageProxy } = await import(
      `../backend/services/imageProxyService.js?burst-test=${Date.now()}`
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const calls = [];
    let fail = true;
    global.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 2) started.resolve();
      await gate.promise;
      if (String(url).endsWith("/fail.png") && fail) throw new Error("upstream unavailable");
      return new Response(png, { headers: { "content-type": "image/png" } });
    };
    const urls = ["fail", "second", "third", "fourth", "fail"]
      .map((name) => `https://images.example/${name}.png`);
    requests = Promise.allSettled(urls.map((url) => warmImageProxy(url)));
    await started.promise;
    await new Promise(setImmediate);
    assert.equal(calls.length, 2, "queued requests must not hold source image bytes");
    gate.resolve();
    const results = await requests;
    assert.deepEqual(results.map((result) => result.status), [
      "rejected", "fulfilled", "fulfilled", "fulfilled", "rejected",
    ]);
    assert.equal(calls.filter((url) => url.endsWith("/fail.png")).length, 1);
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
});

test("image proxy cache size and clear operations are asynchronous", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-image-cache-"));
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  process.env.AURRAL_DATA_DIR = dataDir;
  try {
    const { clearImageProxyCache, getImageProxyCacheSizeBytes } = await import(
      `../backend/services/imageProxyService.js?cache-test=${Date.now()}`
    );
    const cacheDir = path.join(dataDir, "image-proxy");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "sample.webp"), "abc");

    assert.equal(await getImageProxyCacheSizeBytes(), 3);
    await clearImageProxyCache();
    assert.deepEqual(await fs.readdir(cacheDir), []);
  } finally {
    if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
    else process.env.AURRAL_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("image proxy caches one library-sized webp instead of full-resolution sources", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-image-library-"));
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  const originalFetch = global.fetch;
  process.env.AURRAL_DATA_DIR = dataDir;
  try {
    const sharp = (await import("sharp")).default;
    const { warmImageProxy } = await import(
      `../backend/services/imageProxyService.js?library-test=${Date.now()}`
    );
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

    global.fetch = async () =>
      new Response(source, { headers: { "content-type": "image/png" } });

    const cached = await warmImageProxy("https://images.example/large-library.png");
    assert.equal(cached.meta.contentType, "image/webp");
    assert.ok(cached.meta.size <= 150 * 1024);

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
  let server;
  process.env.AURRAL_DATA_DIR = dataDir;
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    global.fetch = async () =>
      new Response(png, { headers: { "content-type": "image/png" } });

    const { handleImageProxyRequest, warmImageProxy } = await import(
      `../backend/services/imageProxyService.js?hidden-path-test=${Date.now()}`
    );
    const cached = await warmImageProxy("https://images.example/hidden-path.png");
    global.fetch = originalFetch;

    const app = express();
    app.get("/api/image-proxy/:cacheKey", handleImageProxyRequest);
    app.use((error, _req, res, _next) => {
      res.status(500).json({ error: error.message });
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });

    const response = await fetch(`http://127.0.0.1:${server.address().port}${cached.localUrl}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  } finally {
    global.fetch = originalFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
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
    const { warmImageProxy, getImageProxyCacheSizeBytes } = await import(
      `../backend/services/imageProxyService.js?cap-test=${Date.now()}`
    );
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
        .png()
        .toBuffer();
      global.fetch = async () =>
        new Response(variant, { headers: { "content-type": "image/png" } });
      await warmImageProxy(`https://images.example/cap-${i}.png`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const size = await getImageProxyCacheSizeBytes();
    assert.ok(size <= 200 * 1024, `cache size ${size} exceeded 200KiB cap`);
    const files = await fs.readdir(path.join(dataDir, "image-proxy"));
    const images = files.filter((name) => name.endsWith(".webp"));
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
