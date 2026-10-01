import { createHash, randomInt } from "node:crypto";
import { stableUuid } from "../brainzmash.mjs";
import { solidPng } from "../runtime.mjs";

export function plexAccounts(serverToken) {
  const token = (seed) => createHash("sha1").update(`${serverToken}:${seed}`).digest("hex").slice(0, 20);
  return [
    { id: 9001, title: "Lab Plex Owner", username: "lab-plex-owner", home: true, admin: true, restricted: false, owned: true },
    { id: 9002, title: "Lab Teen", username: "", home: true, admin: false, restricted: true, owned: false },
    { id: 9003, title: "Lab Plex Friend", username: "lab-plex-friend", home: false, admin: false, restricted: false, owned: false },
  ].map((account) => ({
    ...account,
    uuid: stableUuid(`plex-account:${account.id}`).replaceAll("-", "").slice(0, 16),
    email: account.username ? `${account.username}@lab.invalid` : null,
    accountToken: account.owned ? serverToken : token(`account:${account.id}`),
    serverToken: account.owned ? serverToken : token(`server:${account.id}`),
  }));
}

const authPage = (accounts) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Plex (Aurral Lab)</title></head>
<body style="font-family: sans-serif; max-width: 28rem; margin: 3rem auto">
<h1>Sign in to Plex</h1>
<p>This is the Aurral Lab Plex sign-in. Choose the disposable account to approve.</p>
${accounts.map((account) => `<p><button type="button" data-account="${account.id}">Continue as ${account.title}</button></p>`).join("\n")}
<p id="status" role="status"></p>
<script>
  const params = new URLSearchParams(location.hash.replace(/^#\\??/, ""));
  for (const button of document.querySelectorAll("button[data-account]")) {
    button.addEventListener("click", async () => {
      const response = await fetch("/lab/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: params.get("code"), clientId: params.get("clientID"), accountId: Number(button.dataset.account) }),
      });
      if (!response.ok) {
        document.getElementById("status").textContent = "Plex could not approve this sign-in.";
        return;
      }
      document.getElementById("status").textContent = "Signed in. You can close this window.";
      const forwardUrl = params.get("forwardUrl");
      if (forwardUrl) location.href = forwardUrl;
      else window.close();
    });
  }
</script>
</body></html>`;

export function createPlexTv({ serverToken, machineIdentifier, serverUrl }) {
  const accounts = plexAccounts(serverToken);
  const state = { pins: [], nextPinId: 7000001, switches: [] };
  const byToken = (headers, url) => {
    const token = headers["x-plex-token"] || url.searchParams.get("X-Plex-Token");
    return accounts.find((account) => account.accountToken === token);
  };
  const userJson = (account) => ({
    id: account.id,
    uuid: account.uuid,
    username: account.username || account.title,
    title: account.title,
    email: account.email,
    thumb: `https://plex.tv/users/${account.uuid}/avatar`,
    authToken: account.accountToken,
    restricted: account.restricted,
    home: account.home,
  });

  const handle = ({ method, url, host, headers, body }) => {
    if (host === "app.plex.tv") {
      if (method === "GET" && url.pathname === "/auth") {
        return { status: 200, raw: authPage(accounts.filter((account) => account.username)), headers: { "content-type": "text/html; charset=utf-8" } };
      }
      if (method === "POST" && url.pathname === "/lab/approve") {
        const pin = state.pins.find((entry) => entry.code === body?.code && entry.clientId === body?.clientId);
        const account = accounts.find((entry) => entry.id === body?.accountId && entry.username);
        if (!pin || !account) return { status: 404, body: { error: "Unknown PIN or account" } };
        pin.authToken = account.accountToken;
        return { status: 200, body: { approved: true } };
      }
      return null;
    }
    if (method === "GET" && /^\/users\/[0-9a-f]+\/avatar$/.test(url.pathname)) {
      return { status: 200, raw: solidPng(url.pathname, 96), headers: { "content-type": "image/png" } };
    }
    const clientId = headers["x-plex-client-identifier"];
    if (method === "POST" && url.pathname === "/api/v2/pins") {
      if (!clientId) return { status: 400, body: { errors: [{ code: 1000, message: "X-Plex-Client-Identifier is missing" }] } };
      const pin = { id: state.nextPinId++, code: randomInt(36 ** 7, 36 ** 8).toString(36), clientId, authToken: null, createdAt: Date.now() };
      state.pins.push(pin);
      return { status: 201, body: { id: pin.id, code: pin.code, product: headers["x-plex-product"] || null, clientIdentifier: clientId, authToken: null, expiresIn: 1800 } };
    }
    const pinMatch = /^\/api\/v2\/pins\/(\d+)$/.exec(url.pathname);
    if (method === "GET" && pinMatch) {
      const pin = state.pins.find((entry) => entry.id === Number(pinMatch[1]) && entry.clientId === clientId);
      if (!pin) return { status: 404, body: { errors: [{ code: 1020, message: "Code not found or expired" }] } };
      return { status: 200, body: { id: pin.id, code: pin.code, clientIdentifier: pin.clientId, authToken: pin.authToken } };
    }
    const account = byToken(headers, url);
    if (!account) return { status: 401, body: { errors: [{ code: 1001, message: "User could not be authenticated" }] } };
    if (method === "GET" && url.pathname === "/api/v2/user") return { status: 200, body: userJson(account) };
    if (method === "GET" && url.pathname === "/api/v2/resources") {
      const server = new URL(serverUrl);
      return {
        status: 200,
        body: [{
          name: "Aurral Lab Plex",
          product: "Plex Media Server",
          provides: "server",
          clientIdentifier: machineIdentifier,
          owned: account.owned,
          accessToken: account.serverToken,
          connections: [{ protocol: server.protocol.replace(":", ""), address: server.hostname, port: Number(server.port), uri: server.origin, local: true }],
        }],
      };
    }
    if (method === "GET" && url.pathname === "/api/v2/home/users") {
      if (!account.admin) return { status: 403, body: { errors: [{ code: 1003, message: "Only the home admin can list users" }] } };
      return { status: 200, body: { users: accounts.filter((entry) => entry.home).map((entry) => ({ ...userJson(entry), admin: entry.admin, guest: false })) } };
    }
    const switchMatch = /^\/api(?:\/v2)?\/home\/users\/(\d+)\/switch$/.exec(url.pathname);
    if (method === "POST" && switchMatch) {
      const target = accounts.find((entry) => entry.id === Number(switchMatch[1]) && entry.home);
      if (!account.admin || !target) return { status: 404, body: { errors: [{ code: 1002, message: "Home user not found" }] } };
      state.switches.push({ from: account.id, to: target.id, at: new Date().toISOString() });
      return { status: 201, body: { ...userJson(target), authToken: target.accountToken } };
    }
    return null;
  };
  handle.state = state;
  handle.restore = (saved) => Object.assign(state, saved);
  return { name: "plextv", hosts: ["plex.tv", "app.plex.tv"], handle };
}
