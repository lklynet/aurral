import net from "node:net";

const LAB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "fixtures", "aurral"]);
const reported = new Set();

function targetHost(args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options && typeof options === "object") return options.path ? null : options.host ?? options.hostname ?? "localhost";
  return typeof args[1] === "string" ? args[1] : "localhost";
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function labEgressJournal(...args) {
  const host = targetHost(args);
  if (host && !LAB_HOSTS.has(host) && !reported.has(host)) {
    reported.add(host);
    console.error(`[lab-egress] blocked outbound connection to ${host}`);
  }
  return connect.apply(this, args);
};
