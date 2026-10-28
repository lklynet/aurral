import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { safeLogDiagnostic } from "../../backend/services/logger.ts";

test("log diagnostics mask credentials, collapse lines, and cap length", () => {
  const error = new Error(
    "Request to https://example.test/api?token=url-secret failed\n" +
      "Authorization: Bearer bearer-secret ARL=arl-secret",
  );
  error.stack = "stack-secret";
  assert.equal(
    safeLogDiagnostic(error),
    "Request to https://example.test/api?token=*** failed Authorization=*** ARL=***",
  );
  assert.equal(
    safeLogDiagnostic("Testing https://alice:my-password@lidarr.example/api"),
    "Testing https://***@lidarr.example/api",
  );
  assert.equal(safeLogDiagnostic("Cookie: session=cookie-secret"), "Cookie=***");
  assert.equal(
    safeLogDiagnostic('client_secret=snake-value "clientSecret": "camel-value"'),
    "client_secret=*** clientSecret=***",
  );
  assert.equal(
    safeLogDiagnostic('Could not read "/music/Artist/Album/01 Song.flac"'),
    'Could not read "/music/Artist/Album/01 Song.flac"',
  );
  assert.equal(safeLogDiagnostic("x".repeat(1000)).length, 501);
  assert.equal(safeLogDiagnostic("Connection refused"), "Connection refused");
  const htmlError = Object.assign(
    new Error(
      "<!DOCTYPE html><html><head><title>524: A timeout occurred</title></head><body>large page</body></html>",
    ),
    { statusCode: 524 },
  );

  assert.equal(safeLogDiagnostic(htmlError), "Upstream HTML error (524): 524: A timeout occurred");
});

test("HTML error titles are extracted without repeated scans of malformed input", () => {
  assert.equal(
    safeLogDiagnostic('<html><head><TITLE class="status">Gateway error</TITLE></head></html>'),
    "Upstream HTML error: Gateway error",
  );
  const malformed = `<!doctype html><html><head>${"<title".repeat(5000)}</head></html>`;
  assert.equal(safeLogDiagnostic(malformed), "Upstream HTML error");
  assert.equal(
    safeLogDiagnostic(`<html><title>${"x".repeat(201)}</title></html>`),
    "Upstream HTML error",
  );
});

test("logger sink masks nested credentials and keeps file paths", async () => {
  const output: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => output.push(args);
  try {
    vi.resetModules();
    const { logger } = await import("../../backend/services/logger.ts");
    logger.error("workers", "Provider failed", {
      reason: new Error(
        "Failed at /config/private/provider.json: https://example.test/?token=url-secret",
      ),
      headers: { authorization: "Bearer bearer-secret", clientSecret: "client-secret" },
      endpoint: "/album",
    });
    assert.partialDeepStrictEqual(output[0][2], {
      reason: "Failed at /config/private/provider.json: https://example.test/?token=***",
      headers: { authorization: "***", clientSecret: "***" },
      endpoint: "/album",
    });
    logger.error("workers", "Unsafe endpoint", { endpoint: "/album?token=endpoint-secret" });
    assert.doesNotMatch(JSON.stringify(output[1]), /endpoint-secret/);
  } finally {
    console.error = originalError;
  }
});

test("simplified logger writes to console with level and category", async () => {
  const output: unknown[][] = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  console.log = (...args) => output.push(["log", ...args]);
  console.error = (...args) => output.push(["error", ...args]);
  console.warn = (...args) => output.push(["warn", ...args]);

  try {
    vi.resetModules();
    const { logger } = await import("../../backend/services/logger.ts");
    logger.info("test", "Server running on port 3001", { key: "val" });
    logger.warn("test", "warn message");
    logger.error("test", "error message");

    const rendered = (entry: unknown[]) => entry.slice(1).map(String).join(" ");

    assert.ok(
      output.some(
        (entry) =>
          entry[0] === "log" &&
          rendered(entry).includes("[info]") &&
          rendered(entry).includes("[test]") &&
          rendered(entry).includes("Server running"),
      ),
    );
    assert.ok(output.some((entry) => entry[0] === "warn" && rendered(entry).includes("[warn]")));
    assert.ok(output.some((entry) => entry[0] === "error" && rendered(entry).includes("[error]")));
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
});

test("regular logger hides routine info and debug output", async () => {
  const output: unknown[][] = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  const previousVerboseLogs = process.env.AURRAL_VERBOSE_LOGS;
  console.log = (...args) => output.push(["log", ...args]);
  console.error = (...args) => output.push(["error", ...args]);
  console.warn = (...args) => output.push(["warn", ...args]);

  try {
    process.env.AURRAL_VERBOSE_LOGS = "";
    vi.resetModules();
    const { logger } = await import("../../backend/services/logger.ts");
    logger.info("test", "routine info");
    logger.info("playlist-import", "Playlist import job completed");
    logger.debug("test", "debug detail");
    logger.warn("test", "important warning");

    const rendered = (entry: unknown[]) => entry.slice(1).map(String).join(" ");

    assert.doesNotMatch(output.map(rendered).join("\n"), /routine info|debug detail/);
    assert.match(output.map(rendered).join("\n"), /Playlist import job completed/);
    assert.match(output.map(rendered).join("\n"), /important warning/);
  } finally {
    if (previousVerboseLogs === undefined) delete process.env.AURRAL_VERBOSE_LOGS;
    else process.env.AURRAL_VERBOSE_LOGS = previousVerboseLogs;
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
});

test("regular server console suppresses raw routine output", () => {
  const loggerUrl = new URL("../../backend/services/logger.ts", import.meta.url).href;
  const probe = [
    'process.argv[1] = "/app/server.ts";',
    `await import(${JSON.stringify(loggerUrl)});`,
    'console.log("routine raw output");',
    'console.log("Server running on port 3001");',
    'console.warn("important warning");',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, AURRAL_VERBOSE_LOGS: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(output, /routine raw output/);
  assert.match(output, /Server running on port 3001/);
  assert.match(output, /important warning/);
});

test("an unhandled rejection with a null reason is logged without throwing", async () => {
  const output: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => output.push(args);
  try {
    vi.resetModules();
    const { logUnhandledRejection } = await import("../../backend/services/logger.ts");
    assert.doesNotThrow(() => logUnhandledRejection(null));
    assert.doesNotThrow(() => logUnhandledRejection(undefined));
    assert.equal(output.length, 2);
    assert.match(String(output[0]), /Unhandled Rejection:/);
  } finally {
    console.error = originalError;
  }
});
