import net from "node:net";

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
  const error = new Error(
    `Unit tests cannot reach external hosts. Stub the client that requested ${host}.`,
  );
  process.nextTick(() => this.destroy(error));
  return this;
};
