function normalizePort(value) {
  const port = Number.parseInt(value, 10);
  return Number.isFinite(port) && port > 0 ? String(port) : "";
}

function normalizeHost(value) {
  const host = String(value || "").trim();
  if (!host) return "";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function parseConnectionAddress(value, fallbackPort) {
  const address = String(value || "").trim();
  if (!address) return { host: "", port: "" };

  if (address.startsWith("[")) {
    const closingBracket = address.indexOf("]");
    if (closingBracket <= 1) return { host: "", port: "" };
    const suffix = address.slice(closingBracket + 1);
    if (!suffix) {
      return { host: address.slice(1, closingBracket), port: fallbackPort };
    }
    if (!suffix.startsWith(":")) return { host: "", port: "" };
    const port = normalizePort(suffix.slice(1));
    return port
      ? { host: address.slice(1, closingBracket), port }
      : { host: "", port: "" };
  }

  const colonCount = (address.match(/:/g) || []).length;
  if (colonCount === 1) {
    const separator = address.lastIndexOf(":");
    const port = normalizePort(address.slice(separator + 1));
    return port
      ? { host: address.slice(0, separator), port }
      : { host: "", port: "" };
  }

  return { host: address, port: fallbackPort };
}

function isLocalConnection(connection) {
  return connection?.local === true || connection?.local === 1 || connection?.local === "1";
}

export function resolvePlexConnectionUrl(connection) {
  const uri = String(connection?.uri || "").trim();
  const address = parseConnectionAddress(
    connection?.address,
    normalizePort(connection?.port),
  );
  const host = normalizeHost(address.host);
  const port = address.port;

  if (isLocalConnection(connection) && host && port) {
    return `http://${host}:${port}`;
  }

  return uri;
}

export function pickBestPlexConnection(server) {
  const connections = Array.isArray(server?.connections) ? server.connections : [];
  return (
    connections.find((connection) => isLocalConnection(connection) && resolvePlexConnectionUrl(connection)) ||
    connections.find((connection) => resolvePlexConnectionUrl(connection)) ||
    null
  );
}
