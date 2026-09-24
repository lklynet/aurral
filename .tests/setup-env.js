import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function connectTarget(args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options && typeof options === "object") {
    if (options.path) return null;
    return options.host ?? options.hostname ?? "localhost";
  }
  return typeof args[1] === "string" ? args[1] : "localhost";
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function offlineConnect(...args) {
  const host = connectTarget(args);
  if (host === null || LOOPBACK_HOSTS.has(host) || host.endsWith(".invalid")) {
    return realConnect.apply(this, args);
  }
  const error = new Error(`Unit tests cannot reach external hosts. Stub the client that requested ${host}.`);
  process.nextTick(() => this.destroy(error));
  return this;
};

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
