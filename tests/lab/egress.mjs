import dns from "node:dns";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "aurral", "fixtures"]);
const publicHosts = new Set(JSON.parse(readFileSync(new URL("./services/public-hosts.json", import.meta.url), "utf8")));
const redirects = JSON.parse(process.env.AURRAL_LAB_REDIRECTS || "{}");
const [publicTlsHost, publicTlsPort] = String(process.env.AURRAL_LAB_PUBLIC_TLS || "fixtures:8443").split(":");
const [publicHttpHost, publicHttpPort] = String(process.env.AURRAL_LAB_PUBLIC_HTTP || "fixtures:8079").split(":");
const reported = new Set();
const PUBLIC_ADDRESS = { address: "198.20.0.10", family: 4 };

const lookup = dns.lookup;
dns.lookup = function labLookup(hostname, options, callback) {
  if (!publicHosts.has(String(hostname).toLowerCase())) return lookup.apply(this, arguments);
  const done = typeof options === "function" ? options : callback;
  const all = typeof options === "object" && options?.all;
  process.nextTick(() => (all ? done(null, [PUBLIC_ADDRESS]) : done(null, PUBLIC_ADDRESS.address, PUBLIC_ADDRESS.family)));
};
const lookupPromise = dns.promises.lookup;
dns.promises.lookup = async function labLookup(hostname, options) {
  if (!publicHosts.has(String(hostname).toLowerCase())) return lookupPromise.call(this, hostname, options);
  return (typeof options === "object" && options?.all) ? [PUBLIC_ADDRESS] : PUBLIC_ADDRESS;
};
syncBuiltinESMExports();

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
  if (publicHosts.has(host)) {
    const tls = port !== 80;
    return { host: tls ? publicTlsHost : publicHttpHost, port: Number(tls ? publicTlsPort : publicHttpPort) };
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
  const { lookup: _pinnedLookup, ...rest } = options || {};
  const rewritten = { ...rest, host: destination.host, port: destination.port };
  return connect.call(this, rewritten, ...(callback ? [callback] : []));
};
