import net from "node:net";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function connectTarget(
  args: [
    string | number | net.SocketConnectOpts,
    string | (() => void) | (() => void) | (() => void) | undefined,
    unknown?,
  ],
) {
  const options: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options && typeof options === "object") {
    if ("path" in options && options.path) return null;
    const host = ("host" in options && options.host) || ("hostname" in options && options.hostname);
    return typeof host === "string" ? host : "localhost";
  }
  return typeof args[1] === "string" ? args[1] : "localhost";
}

export const blockedHosts = new Map<string, number>();

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function offlineConnect(...args) {
  const host = connectTarget(args);
  if (host === null || LOOPBACK_HOSTS.has(host) || host.endsWith(".invalid")) {
    return Reflect.apply(realConnect, this, args);
  }
  blockedHosts.set(host, (blockedHosts.get(host) ?? 0) + 1);
  const error = new Error(
    `Unit tests cannot reach external hosts. Stub the client that requested ${host}.`,
  );
  process.nextTick(() => this.destroy(error));
  return this;
};
