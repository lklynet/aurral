import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isPrivateAddress, isPrivateHostname, isPublicUrl } from "../lib/publicUrl.js";

test("isPrivateHostname blocks bracketed IPv6 loopback from URL hostnames", () => {
  assert.equal(isPrivateHostname(new URL("http://[::1]/x.jpg").hostname), true);
  assert.equal(isPrivateHostname("[::1]"), true);
  assert.equal(isPrivateHostname("example.com"), false);
});

test("image proxy rejects non-public address ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "fc00::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("public URL checks accept public hostnames and reject embedded private addresses", () => {
  assert.equal(isPublicUrl("https://fdroid.org/feed.xml"), true);
  assert.equal(isPublicUrl("https://[2606:4700:4700::1111]/feed.xml"), true);
  for (const url of [
    "http://[64:ff9b::7f00:1]/feed.xml",
    "http://[2002:7f00:1::1]/feed.xml",
    "http://198.51.100.7/feed.xml",
    "http://printer.local/feed.xml",
  ]) {
    assert.equal(isPublicUrl(url), false, url);
  }
});

test("image proxy validates every hop and bounds untrusted image data", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-image-security-"));
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  const originalFetch = global.fetch;
  const originalLookup = dns.lookup;
  process.env.AURRAL_DATA_DIR = dataDir;

  try {
    const { warmImageProxy } = await import(
      `../backend/services/imageProxyService.js?security-test=${Date.now()}`
    );

    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private.png" },
      });
    };
    await assert.rejects(
      warmImageProxy("https://images.example/redirect.png"),
      /private host/,
    );
    assert.equal(calls, 1);

    global.fetch = async () =>
      new Response("x", {
        headers: {
          "content-type": "image/png",
          "content-length": String(25 * 1024 * 1024 + 1),
        },
      });
    await assert.rejects(
      warmImageProxy("https://images.example/oversized.png"),
      /size limit/,
    );

    global.fetch = async () =>
      new Response("<html>not an image</html>", {
        headers: { "content-type": "image/png" },
      });
    await assert.rejects(
      warmImageProxy("https://images.example/spoofed.png"),
      /Invalid or oversized image data/,
    );

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    global.fetch = async () =>
      new Response(png, { headers: { "content-type": "image/png" } });
    const cached = await warmImageProxy("https://images.example/valid.png");
    assert.equal(cached.meta.contentType, "image/webp");
    assert.match(cached.localUrl, /^\/api\/image-proxy\/[a-f0-9]{64}\.webp$/);

    global.fetch = async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', {
        headers: { "content-type": "image/svg+xml" },
      });
    const cachedSvg = await warmImageProxy("https://images.example/valid.svg");
    assert.equal(cachedSvg.meta.contentType, "image/webp");

    global.fetch = originalFetch;
    dns.lookup = (_hostname, _options, callback) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    await assert.rejects(
      warmImageProxy("https://dns-rebinding.invalid/image.png"),
      (error) => error?.cause?.code === "EHOSTUNREACH",
    );
  } finally {
    global.fetch = originalFetch;
    dns.lookup = originalLookup;
    if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
    else process.env.AURRAL_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
