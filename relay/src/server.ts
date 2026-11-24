import { createRelayServer } from "./relay.ts";

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";

const trustedProxies = (process.env.TRUSTED_PROXY_IPS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const relay = createRelayServer({
  connectDomain: process.env.CONNECT_DOMAIN || "aurral.dev",
  appOrigin: process.env.APP_ORIGIN || "https://music.aurral.org",
  hubOrigin: process.env.HUB_ORIGIN || "https://aurral.org",
  relaySecret: process.env.CONNECT_RELAY_SECRET || undefined,
  trustedProxies,
});

const boundPort = await relay.listen(port, host);
console.log(`[aurral-relay] listening on ${host}:${boundPort}`);

const shutdown = async (signal: NodeJS.Signals) => {
  console.log(`[aurral-relay] received ${signal}, shutting down`);
  await relay.close();
  process.exit(0);
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
