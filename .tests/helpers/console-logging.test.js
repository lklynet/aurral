import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { isVerboseConsoleEnabled } from "../../backend/config/constants.js";
import { safeLogDiagnostic } from "../../backend/services/logger.js";

test("log diagnostics redact credentials, collapse lines, and cap length", () => {
  const error = new Error(
    "Request to https://user:pass@example.test/api?token=url-secret failed\n" +
      "Authorization: Bearer bearer-secret token=token-secret ARL=arl-secret",
  );
  error.stack = "stack-secret";
  const diagnostic = safeLogDiagnostic(error);
  assert.match(diagnostic, /Request to \[redacted URL\] failed/);
  assert.doesNotMatch(diagnostic, /url-secret|bearer-secret|token-secret|arl-secret|stack-secret|\n/);
  assert.equal(safeLogDiagnostic("Cookie: session=cookie-secret"), "Cookie=[redacted]");
  assert.equal(safeLogDiagnostic({ message: "token=object-secret" }), "token=[redacted]");
  assert.equal(safeLogDiagnostic("x".repeat(1000)).length, 501);
  assert.equal(safeLogDiagnostic("Connection refused"), "Connection refused");
});

test("verbose console mode respects explicit environment values", () => {
  assert.equal(isVerboseConsoleEnabled({ AURRAL_VERBOSE_LOGS: "true" }), true);
  assert.equal(isVerboseConsoleEnabled({ AURRAL_VERBOSE_LOGS: "1" }), true);
  assert.equal(isVerboseConsoleEnabled({ AURRAL_VERBOSE_LOGS: "debug" }), true);
  assert.equal(isVerboseConsoleEnabled({}), false);
  assert.equal(isVerboseConsoleEnabled({ AURRAL_VERBOSE_LOGS: "false" }), false);
  assert.equal(isVerboseConsoleEnabled({ AURRAL_VERBOSE_LOGS: "0" }), false);
});

test("simplified logger writes to console with level and category", async () => {
  const output = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  console.log = (...args) => output.push(["log", ...args]);
  console.error = (...args) => output.push(["error", ...args]);
  console.warn = (...args) => output.push(["warn", ...args]);

  try {
    const { logger } = await import(
      `../../backend/services/logger.js?console-test=${Date.now()}`
    );
    logger.info("test", "Server running on port 3001", { key: "val" });
    logger.warn("test", "warn message");
    logger.error("test", "error message");

    const rendered = (entry) => entry.slice(1).map(String).join(" ");

    assert.ok(output.some((entry) => entry[0] === "log" && rendered(entry).includes("[info]") && rendered(entry).includes("[test]") && rendered(entry).includes("Server running")));
    assert.ok(output.some((entry) => entry[0] === "warn" && rendered(entry).includes("[warn]")));
    assert.ok(output.some((entry) => entry[0] === "error" && rendered(entry).includes("[error]")));
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
});

test("regular logger hides routine info and debug output", async () => {
  const output = [];
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
    const { logger } = await import(
      `../../backend/services/logger.js?regular-test=${Date.now()}`
    );
    logger.info("test", "routine info");
    logger.info("playlist-import", "Playlist import job completed");
    logger.debug("test", "debug detail");
    logger.warn("test", "important warning");

    const rendered = (entry) => entry.slice(1).map(String).join(" ");

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

test("regular console keeps startup and problem messages", async () => {
  const { shouldEmitDefaultConsoleMessage } = await import(
    `../../backend/services/logger.js?policy-test=${Date.now()}`
  );
  assert.equal(
    shouldEmitDefaultConsoleMessage("log", ["Server running on port 3001"]),
    true,
  );
  assert.equal(
    shouldEmitDefaultConsoleMessage("log", ["Discovery cache is fresh"]),
    false,
  );
  assert.equal(shouldEmitDefaultConsoleMessage("warn", ["warning"]), true);
  assert.equal(shouldEmitDefaultConsoleMessage("log", ["Playlist import queued"]), true);
  assert.equal(shouldEmitDefaultConsoleMessage("log", ["Playlist import job completed"]), true);
  assert.equal(shouldEmitDefaultConsoleMessage("log", ["Playlist import sync completed"]), true);
  assert.equal(shouldEmitDefaultConsoleMessage("debug", ["details"]), false);
});

test("regular server console suppresses raw routine output", () => {
  const loggerUrl = new URL("../../backend/services/logger.js", import.meta.url).href;
  const probe = [
    'process.argv[1] = "/app/server.js";',
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
