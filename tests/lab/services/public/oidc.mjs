import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";

const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const base64url = (value) => Buffer.from(value).toString("base64url");

function createIssuer({ issuer, endpoints, label, clients, accounts }) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = createHash("sha1").update(issuer).digest("hex").slice(0, 16);
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const requests = new Map();
  const codes = new Map();
  const accessTokens = new Map();

  const sign = (claims) => {
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }))}.${base64url(JSON.stringify(claims))}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
  };
  const clientFrom = (headers, form) => {
    const basic = /^Basic (.+)$/i.exec(String(headers.authorization || ""));
    const [id, secret] = basic
      ? Buffer.from(basic[1], "base64").toString("utf8").split(":").map(decodeURIComponent)
      : [form.client_id, form.client_secret];
    const client = clients.find((entry) => entry.id === id);
    if (!client) return null;
    if (client.secret && client.secret !== secret) return null;
    return client;
  };
  const metadata = {
    issuer,
    authorization_endpoint: endpoints.authorize,
    token_endpoint: endpoints.token,
    userinfo_endpoint: endpoints.userinfo,
    jwks_uri: endpoints.jwks,
    ...(endpoints.logout ? { end_session_endpoint: endpoints.logout } : {}),
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile", "groups"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: ["sub", "email", "email_verified", "name", "preferred_username", "groups"],
  };
  const at = (endpoint, url, host) => {
    const target = new URL(endpoint);
    return target.hostname === host && target.pathname === url.pathname;
  };

  return {
    hosts: [...new Set([new URL(issuer).hostname, ...Object.values(endpoints).map((endpoint) => new URL(endpoint).hostname)])],
    handle({ method, url, host, headers, body }) {
      if (method === "GET" && host === new URL(issuer).hostname && url.pathname === `${new URL(issuer).pathname.replace(/\/$/, "")}/.well-known/openid-configuration`) {
        return { status: 200, body: metadata };
      }
      if (method === "GET" && at(endpoints.jwks, url, host)) return { status: 200, body: { keys: [jwk] } };
      if (method === "GET" && url.searchParams.has("lab_request") && at(endpoints.authorize, url, host)) {
        const params = requests.get(url.searchParams.get("lab_request"));
        const account = accounts.find((entry) => entry.sub === url.searchParams.get("lab_account"));
        if (!params || !account) return { status: 400, raw: "Unknown sign-in request", headers: { "content-type": "text/plain" } };
        requests.delete(url.searchParams.get("lab_request"));
        const code = randomUUID();
        codes.set(code, { params, account, expiresAt: Date.now() + 60_000 });
        const target = new URL(params.redirect_uri);
        target.searchParams.set("code", code);
        if (params.state) target.searchParams.set("state", params.state);
        return { status: 302, headers: { location: target.href }, raw: "" };
      }
      if (method === "GET" && at(endpoints.authorize, url, host)) {
        const params = Object.fromEntries(url.searchParams);
        const client = clients.find((entry) => entry.id === params.client_id);
        if (!client || params.response_type !== "code" || !params.redirect_uri) {
          return { status: 400, raw: `${label} rejected this sign-in request.`, headers: { "content-type": "text/plain" } };
        }
        const id = randomUUID();
        requests.set(id, params);
        const links = accounts.map((account) => `<p><a href="${escape(`${url.pathname}?lab_request=${id}&lab_account=${encodeURIComponent(account.sub)}`)}">Continue as ${escape(account.name)}</a></p>`);
        return {
          status: 200,
          raw: `<!doctype html><html><head><meta charset="utf-8"><title>${escape(label)} (Aurral Lab)</title></head><body style="font-family: sans-serif; max-width: 28rem; margin: 3rem auto"><h1>Sign in with ${escape(label)}</h1><p>Choose a disposable Lab account.</p>${links.join("")}</body></html>`,
          headers: { "content-type": "text/html; charset=utf-8" },
        };
      }
      if (method === "POST" && at(endpoints.token, url, host)) {
        const form = body || {};
        const client = clientFrom(headers, form);
        if (!client) return { status: 401, body: { error: "invalid_client" } };
        const grant = codes.get(form.code);
        codes.delete(form.code);
        const challenge = grant && createHash("sha256").update(String(form.code_verifier || "")).digest("base64url");
        if (
          form.grant_type !== "authorization_code" ||
          !grant ||
          grant.expiresAt < Date.now() ||
          grant.params.client_id !== client.id ||
          grant.params.redirect_uri !== form.redirect_uri ||
          (grant.params.code_challenge && grant.params.code_challenge !== challenge)
        ) {
          return { status: 400, body: { error: "invalid_grant" } };
        }
        const now = Math.floor(Date.now() / 1000);
        const accessToken = randomUUID();
        accessTokens.set(accessToken, grant.account);
        const { name, email, groups, sub, preferred_username: username } = grant.account;
        return {
          status: 200,
          body: {
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: grant.params.scope,
            id_token: sign({
              iss: issuer,
              aud: client.id,
              sub,
              iat: now,
              exp: now + 3600,
              ...(grant.params.nonce ? { nonce: grant.params.nonce } : {}),
              email,
              email_verified: true,
              name,
              ...(username ? { preferred_username: username } : {}),
              ...(groups ? { groups } : {}),
            }),
          },
        };
      }
      if (method === "GET" && at(endpoints.userinfo, url, host)) {
        const account = accessTokens.get(String(headers.authorization || "").replace(/^Bearer /i, ""));
        if (!account) return { status: 401, body: { error: "invalid_token" } };
        return { status: 200, body: { ...account, email_verified: true } };
      }
      if (endpoints.logout && method === "GET" && at(endpoints.logout, url, host)) {
        const target = url.searchParams.get("post_logout_redirect_uri");
        return target ? { status: 302, headers: { location: target }, raw: "" } : { status: 200, raw: "Signed out", headers: { "content-type": "text/plain" } };
      }
      return null;
    },
  };
}

export function createOidc({ google, sso }) {
  const issuers = [
    createIssuer({
      issuer: "https://accounts.google.com",
      label: "Google",
      endpoints: {
        authorize: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
        userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
        jwks: "https://www.googleapis.com/oauth2/v3/certs",
      },
      clients: [{ id: google.clientId, secret: google.clientSecret }],
      accounts: [
        { sub: "110000000000000000001", name: "Lab Google Listener", email: "lab.google.listener@lab.invalid" },
        { sub: "110000000000000000002", name: "Lab Google Guest", email: "lab.google.guest@lab.invalid" },
      ],
    }),
    createIssuer({
      issuer: sso.issuer,
      label: "Lab SSO",
      endpoints: {
        authorize: new URL("/application/o/authorize/", sso.issuer).href,
        token: new URL("/application/o/token/", sso.issuer).href,
        userinfo: new URL("/application/o/userinfo/", sso.issuer).href,
        jwks: new URL("jwks/", sso.issuer).href,
        logout: new URL("end-session/", sso.issuer).href,
      },
      clients: [{ id: sso.clientId, secret: sso.clientSecret }],
      accounts: [
        { sub: "lab-sso-admin-0001", preferred_username: "lab-sso-admin", name: "Lab SSO Admin", email: "lab-sso-admin@lab.invalid", groups: ["aurral-admins"] },
        { sub: "lab-sso-member-0002", preferred_username: "lab-sso-member", name: "Lab SSO Member", email: "lab-sso-member@lab.invalid", groups: ["aurral-users"] },
      ],
    }),
  ];
  const handle = async (request) => {
    for (const issuer of issuers) {
      if (!issuer.hosts.includes(request.host)) continue;
      const result = issuer.handle(request);
      if (result) return result;
    }
    return null;
  };
  return { name: "oidc", hosts: [...new Set(issuers.flatMap((issuer) => issuer.hosts))], handle };
}
