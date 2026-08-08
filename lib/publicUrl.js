import dns from "node:dns/promises";
import net from "node:net";

const isPrivateIpv4 = (value) => {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
};

const isPrivateIp = (value) => {
  const ip = String(value || "").toLowerCase();
  if (net.isIP(ip) === 4) return isPrivateIpv4(ip);
  const mappedIpv4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4[1]);
  return ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd")
    || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")
    || ip.startsWith("::ffff:");
};

export const isPublicUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return false;
  }
  return ["http:", "https:"].includes(parsed.protocol)
    && parsed.hostname !== "localhost"
    && !isPrivateIp(parsed.hostname.replace(/^\[|\]$/g, ""));
};

export async function assertPublicUrl(value) {
  if (!isPublicUrl(value)) throw new Error("Only public HTTP and HTTPS URLs are allowed");
  const hostname = new URL(value).hostname;
  if (net.isIP(hostname) === 0) {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
      throw new Error("Only public HTTP and HTTPS URLs are allowed");
    }
  }
  return value;
}
