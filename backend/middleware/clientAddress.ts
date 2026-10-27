import { createMiddleware } from "hono/factory";
import proxyaddr from "proxy-addr";
import type { AppEnv } from "./requestUser.ts";

function trustProxy(value: string | undefined) {
  if (value === undefined) return (_address: string, hop: number) => hop < 1;
  if (value === "true") return () => true;
  if (value === "false") return () => false;
  const hops = Number(value);
  if (!Number.isNaN(hops)) return (_address: string, hop: number) => hop < hops;
  return proxyaddr.compile(value.split(",").map((entry) => entry.trim()));
}

const trust = trustProxy(process.env.TRUST_PROXY);

export const clientAddress = createMiddleware<AppEnv>(async (c, next) => {
  const { incoming } = c.env;
  const addresses = proxyaddr.all(incoming, trust).filter(Boolean);
  const socketAddress = incoming.socket.remoteAddress;
  const forwardedProto =
    socketAddress && trust(socketAddress, 0) && c.req.header("x-forwarded-proto");
  c.set("clientIp", addresses.at(-1) ?? "");
  c.set("clientIps", addresses);
  c.set("protocol", forwardedProto ? forwardedProto.split(",")[0].trim() : "http");
  await next();
});
