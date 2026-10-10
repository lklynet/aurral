import { spawn } from "node:child_process";
import readline from "node:readline";
import { logger } from "../logger.js";
import { getShareInstance, SHARE_ORIGIN } from "./store.js";

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const RESTART_DELAYS_MS = [5000, 15000, 60000, 300000];
const REGISTER_DELAYS_MS = [2000, 5000, 10000, 20000, 30000, 60000];
const REGISTER_TIMEOUT_MS = 15000;
const VERIFY_GRACE_MS = 2 * 60 * 1000;

let tunnel = null;
let state = "off";
let restartTimer = null;
let restartAttempt = 0;

const delayFor = (delays, attempt) => delays[Math.min(attempt, delays.length - 1)];

async function callLookup(method, body) {
  const { id, secret } = getShareInstance();
  const response = await fetch(`${SHARE_ORIGIN}/api/instances/${id}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, ...body }),
    signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`aurral.org answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    error.status = response.status;
    throw error;
  }
}

async function register(current, url) {
  const foundAt = Date.now();
  for (let attempt = 0; tunnel === current; attempt += 1) {
    try {
      await callLookup("PUT", { url });
      if (tunnel !== current) return;
      state = "online";
      restartAttempt = 0;
      logger.info("share", `Share tunnel is online at ${url}`);
      return;
    } catch (error) {
      if (tunnel !== current) return;
      const stillPropagating = error.status === 422 && Date.now() - foundAt < VERIFY_GRACE_MS;
      state = stillPropagating ? "starting" : "unreachable";
      if (!stillPropagating) {
        logger.warn("share", "Could not register the share tunnel with aurral.org:", {
          message: error.message,
        });
      }
      await new Promise((resolve) => {
        current.retryTimer = setTimeout(resolve, delayFor(REGISTER_DELAYS_MS, attempt));
        current.retryTimer.unref();
      });
    }
  }
}

function launch(port) {
  const child = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "--url", `http://127.0.0.1:${port}`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const current = { child, port, url: null, retryTimer: null };
  tunnel = current;
  state = "starting";

  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    const match = !current.url && line.match(TUNNEL_URL_PATTERN);
    if (!match) return;
    current.url = match[0];
    void register(current, current.url);
  });

  child.on("error", (error) => {
    if (tunnel !== current) return;
    if (error.code === "ENOENT") {
      tunnel = null;
      state = "unavailable";
      logger.warn("share", "cloudflared is not installed, so listen links cannot be reached");
    }
  });

  child.on("exit", (code, signal) => {
    clearTimeout(current.retryTimer);
    if (tunnel !== current) return;
    tunnel = null;
    state = "starting";
    const delay = delayFor(RESTART_DELAYS_MS, restartAttempt);
    restartAttempt += 1;
    logger.warn("share", `cloudflared stopped (${signal || code}), restarting in ${delay / 1000}s`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch(port);
    }, delay);
    restartTimer.unref();
  });
}

export function startShareTunnel(port) {
  if (tunnel?.port === port || restartTimer) return;
  restartAttempt = 0;
  launch(port);
}

export async function stopShareTunnel() {
  clearTimeout(restartTimer);
  restartTimer = null;
  const current = tunnel;
  tunnel = null;
  if (state !== "unavailable") state = "off";
  if (!current) return;
  clearTimeout(current.retryTimer);
  if (current.child.exitCode === null && current.child.signalCode === null) {
    const exited = new Promise((resolve) => current.child.once("exit", resolve));
    current.child.kill("SIGTERM");
    await exited;
  }
  if (!current.url) return;
  try {
    await callLookup("DELETE", {});
  } catch (error) {
    logger.warn("share", "Could not tell aurral.org the share tunnel stopped:", {
      message: error.message,
    });
  }
}

let cloudflaredCheck = null;

export function hasCloudflared() {
  cloudflaredCheck ??= new Promise((resolve) => {
    const child = spawn("cloudflared", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  }).then((found) => {
    if (!found) cloudflaredCheck = null;
    return found;
  });
  return cloudflaredCheck;
}

export function getShareTunnelState() {
  return state;
}
