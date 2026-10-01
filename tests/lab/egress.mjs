import net from "node:net";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "aurral", "fixtures"]);
const redirects = JSON.parse(process.env.AURRAL_LAB_REDIRECTS || "{}");
const reported = new Set();

function connectOptions(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") return { options: first, host: first.host ?? first.hostname ?? "localhost", port: Number(first.port) };
  return { options: null, host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(first) };
}

function target(host, port) {
  const mapped = redirects[`${host}:${port}`];
  if (mapped) {
    const [mappedHost, mappedPort] = mapped.split(":");
    return { host: mappedHost, port: Number(mappedPort) };
  }
  if (LOCAL_HOSTS.has(host) || host.startsWith("127.")) return null;
  return false;
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function labEgress(...args) {
  const { options, host, port } = connectOptions(args);
  if (options?.path) return connect.apply(this, args);
  const destination = target(host, port);
  if (destination === null) return connect.apply(this, args);
  if (destination === false) {
    if (!reported.has(host)) {
      reported.add(host);
      console.error(`[lab-egress] blocked outbound connection to ${host}`);
    }
    process.nextTick(() => this.destroy(new Error(`Aurral Lab blocked an outbound connection to ${host}`)));
    return this;
  }
  const callback = Array.isArray(args[0]) ? args[0][1] : args.find((arg) => typeof arg === "function");
  const rewritten = { ...(options || {}), host: destination.host, port: destination.port };
  return connect.call(this, rewritten, ...(callback ? [callback] : []));
};
