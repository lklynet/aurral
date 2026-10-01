import dns from "node:dns/promises";
import net from "node:net";

const nonPublicAddresses = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  nonPublicAddresses.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]) {
  nonPublicAddresses.addSubnet(address, prefix, "ipv6");
}

export const isPrivateAddress = (address) => {
  const normalized = String(address || "").split("%")[0];
  const family = net.isIP(normalized);
  if (family === 0) return true;
  if (family === 6) {
    const canonical = net.SocketAddress.parse(`[${normalized}]:0`)?.address;
    if (!canonical || canonical.startsWith("::ffff:")) return true;
  }
  return nonPublicAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
};

const stripBrackets = (hostname) => {
  const value = String(hostname || "").trim().toLowerCase();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
};

export const isPrivateHostname = (hostname) => {
  const normalized = stripBrackets(hostname);
  if (!normalized) return true;
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".home.arpa")
  ) {
    return true;
  }
  return net.isIP(normalized) ? isPrivateAddress(normalized) : false;
};

export const isPublicUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return false;
  }
  return ["http:", "https:"].includes(parsed.protocol) && !isPrivateHostname(parsed.hostname);
};

export async function resolvePublicUrl(value) {
  if (!isPublicUrl(value)) throw new Error("Only public HTTP and HTTPS URLs are allowed");
  const hostname = stripBrackets(new URL(value).hostname);
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Only public HTTP and HTTPS URLs are allowed");
  }
  return { url: value, addresses };
}

export const assertPublicUrl = async (value) => {
  await resolvePublicUrl(value);
  return value;
};
