import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OFFLINE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertOfflineTarget(target) {
  let hostname;
  try {
    hostname = new URL(target).hostname;
  } catch {
    return;
  }
  if (OFFLINE_HOSTS.has(hostname) || hostname.endsWith(".invalid")) return;
  throw new Error(`Unit tests cannot reach external hosts. Stub the client that requested ${hostname}.`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = function offlineFetch(input, init) {
  try {
    assertOfflineTarget(input instanceof Request ? input.url : String(input));
  } catch (error) {
    return Promise.reject(new TypeError("fetch failed", { cause: error }));
  }
  return realFetch.call(this, input, init);
};

for (const client of [http, https]) {
  for (const method of ["request", "get"]) {
    const real = client[method];
    client[method] = function offlineRequest(target, ...rest) {
      const options = typeof target === "string" || target instanceof URL ? String(target) : target;
      assertOfflineTarget(
        typeof options === "string"
          ? options
          : `http://${options?.hostname || options?.host || "localhost"}`,
      );
      return real.call(this, target, ...rest);
    };
  }
}

if (!process.env.AURRAL_DATA_DIR && !process.env.AURRAL_DB_PATH) {
  const dataDir = mkdtempSync(join(tmpdir(), `aurral-test-${process.pid}-`));
  process.env.AURRAL_DATA_DIR = dataDir;
  process.env.AURRAL_DB_PATH = join(dataDir, "aurral.db");
  process.on("exit", () => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });
}
