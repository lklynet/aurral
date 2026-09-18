import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const BUNDLED_MATCHER_PYTHON = "/opt/aurral-matcher/bin/python";
const MATCHER_CATEGORY = "matcher";

const matcherDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "matcher",
);

export function getMatcherScriptPath() {
  return process.env.AURRAL_MATCHER_SCRIPT || path.join(matcherDir, "aurral_matcher.py");
}

export function resolveMatcherPythonPath() {
  if (process.env.AURRAL_MATCHER_PYTHON) return process.env.AURRAL_MATCHER_PYTHON;
  if (existsSync(BUNDLED_MATCHER_PYTHON)) return BUNDLED_MATCHER_PYTHON;
  return "python3";
}

function normalizeMatcherFailure(code, message, stderr = "") {
  return {
    code,
    message,
    stderr: String(stderr || "").slice(-800),
  };
}

async function collectStream(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
}

export async function runMatcherOperation(operation, payload = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const pythonPath = options.pythonPath || resolveMatcherPythonPath();
  const scriptPath = options.scriptPath || getMatcherScriptPath();
  const request = {
    protocol: 1,
    operation,
    ...payload,
  };

  if (!existsSync(scriptPath)) {
    return { ok: false, error: normalizeMatcherFailure("script_unavailable", `matcher script not found at ${scriptPath}`) };
  }

  const child = spawn(pythonPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });

  let settled = false;
  let stdoutText = "";
  let stderrText = "";
  let deadlineTimer = null;

  const timer = setTimeout(() => {
    if (settled || child.exitCode !== null || child.signalCode !== null) return;
    logger.warn(MATCHER_CATEGORY, "matcher timeout, terminating process", {
      operation,
      timeoutMs,
    });
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1500).unref();
  }, timeoutMs);

  try {
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
    const deadline = timeoutMs + 4000;
    const outcome = await Promise.race([
      (async () => {
        const [stdout, stderr] = await Promise.all([
          collectStream(child.stdout, MAX_STDOUT_BYTES),
          collectStream(child.stderr, 64 * 1024),
        ]);
        stdoutText = stdout;
        stderrText = stderr;
        return { exit: await waitForExit(child), deadlineExceeded: false };
      })(),
      new Promise((resolve) => {
        deadlineTimer = setTimeout(
          () => resolve({ exit: null, deadlineExceeded: true }),
          deadline,
        );
        deadlineTimer.unref?.();
      }),
    ]);
    settled = true;
    clearTimeout(timer);

    if (outcome.deadlineExceeded) {
      child.kill("SIGKILL");
      return {
        ok: false,
        error: normalizeMatcherFailure("timeout", `matcher did not terminate within ${deadline}ms`, stderrText),
      };
    }
    const exit = outcome.exit;

    if (spawnError || (exit.code === null && exit.signal === null && !stdoutText)) {
      return {
        ok: false,
        error: normalizeMatcherFailure(
          "python_unavailable",
          `failed to start matcher process ${pythonPath}: ${spawnError?.code || spawnError?.message || "no output"}`,
        ),
      };
    }
    if (exit.signal) {
      return { ok: false, error: normalizeMatcherFailure("timeout", `matcher timed out after ${timeoutMs}ms`, stderrText) };
    }

    let response;
    try {
      response = JSON.parse(stdoutText);
    } catch {
      return {
        ok: false,
        error: normalizeMatcherFailure(
          "bad_response",
          `matcher returned invalid JSON (exit ${exit.code})`,
          stderrText,
        ),
      };
    }
    if (response?.ok !== true) {
      return {
        ok: false,
        error: normalizeMatcherFailure(
          response?.error?.code || "matcher_error",
          response?.error?.message || "matcher reported failure",
          stderrText,
        ),
      };
    }
    if (response.protocol !== SUPPORTED_PROTOCOL_VERSION) {
      return {
        ok: false,
        error: normalizeMatcherFailure(
          "protocol_mismatch",
          `matcher protocol ${response.protocol} != supported ${SUPPORTED_PROTOCOL_VERSION}`,
          stderrText,
        ),
      };
    }
    return { ok: true, result: response, stderr: stderrText };
  } catch (error) {
    clearTimeout(timer);
    return { ok: false, error: normalizeMatcherFailure("matcher_error", String(error?.message || error), stderrText) };
  } finally {
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
  }
}

let availabilityPromise = null;

export function isBeetsMatcherAvailable(options = {}) {
  availabilityPromise ||= runMatcherOperation("health", {}, {
    timeoutMs: options.timeoutMs ?? 10000,
    pythonPath: options.pythonPath,
    scriptPath: options.scriptPath,
  })
    .then((outcome) => {
      if (outcome.ok) {
        logger.debug(MATCHER_CATEGORY, "beets matcher available", {
          beetsVersion: outcome.result?.beetsVersion || "unknown",
        });
        return true;
      }
      logger.debug(MATCHER_CATEGORY, "beets matcher unavailable", {
        code: outcome.error?.code,
      });
      return false;
    })
    .catch(() => false);
  return availabilityPromise;
}

export function resetMatcherAvailability() {
  availabilityPromise = null;
}

// Startup self-test. beets is a production-critical part of the Aurral
// image, so a broken installation must be obvious at startup and through
// the health endpoint instead of being rediscovered per download.
const PINNED_BEETS_VERSION = "2.14.0";
const SUPPORTED_PROTOCOL_VERSION = 1;

let runtimeStatus = {
  available: false,
  checked: false,
  beetsVersion: null,
  protocolVersion: null,
  error: null,
  checkedAt: null,
};

export async function verifyMatcherRuntime(options = {}) {
  runtimeStatus = {
    available: false,
    checked: false,
    beetsVersion: null,
    protocolVersion: null,
    error: null,
    checkedAt: new Date().toISOString(),
  };
  const outcome = await runMatcherOperation("health", {}, {
    timeoutMs: options.timeoutMs ?? 15000,
    pythonPath: options.pythonPath,
    scriptPath: options.scriptPath,
  }).catch((error) => ({
    ok: false,
    error: normalizeMatcherFailure("matcher_error", String(error?.message || error)),
  }));
  runtimeStatus.checked = true;
  if (!outcome.ok) {
    runtimeStatus.error = {
      code: outcome.error?.code || "matcher_error",
      message: outcome.error?.message || "matcher health check failed",
    };
    logger.error(MATCHER_CATEGORY, "beets matcher runtime self-test failed", {
      code: runtimeStatus.error.code,
      message: runtimeStatus.error.message,
    });
    return runtimeStatus;
  }
  const protocolVersion = outcome.result?.protocol;
  const beetsVersion = outcome.result?.beetsVersion || null;
  if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
    runtimeStatus.error = {
      code: "protocol_mismatch",
      message: `matcher protocol ${protocolVersion} != supported ${SUPPORTED_PROTOCOL_VERSION}`,
    };
    logger.error(MATCHER_CATEGORY, "beets matcher protocol mismatch", {
      protocolVersion,
      supported: SUPPORTED_PROTOCOL_VERSION,
    });
    return runtimeStatus;
  }
  if (beetsVersion !== PINNED_BEETS_VERSION) {
    runtimeStatus.error = {
      code: "version_mismatch",
      message: `beets ${beetsVersion || "unknown"} != required ${PINNED_BEETS_VERSION}`,
      found: beetsVersion,
      required: PINNED_BEETS_VERSION,
    };
    logger.error(MATCHER_CATEGORY, "bundled beets version differs from the pinned version", {
      found: beetsVersion,
      pinned: PINNED_BEETS_VERSION,
    });
    return runtimeStatus;
  }
  runtimeStatus.available = true;
  runtimeStatus.beetsVersion = beetsVersion;
  runtimeStatus.protocolVersion = protocolVersion;
  logger.info(MATCHER_CATEGORY, "beets matcher runtime ready", { beetsVersion });
  return runtimeStatus;
}

export function getMatcherRuntimeStatus() {
  return { ...runtimeStatus };
}
