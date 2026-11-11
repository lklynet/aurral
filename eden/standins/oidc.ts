import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

// A single sign-on provider with two people in it and no passwords. Choosing a person
// on its page signs them in to Aurral.

const PORT = Number(process.env.PORT || 8080);
const ISSUER = process.env.EDEN_OIDC_ISSUER || `http://127.0.0.1:${PORT}`;
const KEY_ID = "eden";
const PEOPLE = {
  ada: { name: "Ada", email: "ada@eden.test", groups: ["admins"] },
  grace: { name: "Grace", email: "grace@eden.test", groups: ["listeners"] },
};
type Person = keyof typeof PEOPLE;
const isPerson = (value: string | null): value is Person => Object.hasOwn(PEOPLE, value ?? "");

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const codes = new Map<string, { person: Person; nonce: string | null; client: string | null }>();
const tokens = new Map<string, Person>();

const claims = (person: Person) => ({
  sub: `eden-${person}`,
  preferred_username: person,
  ...PEOPLE[person],
});

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function idToken(person: Person, nonce: string | null, client: string | null) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: "RS256", typ: "JWT", kid: KEY_ID })}.${encode({
    ...claims(person),
    iss: ISSUER,
    aud: client,
    iat: now,
    exp: now + 3600,
    ...(nonce && { nonce }),
  })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
}

const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const page = (query: URLSearchParams) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Eden sign-in</title>
<body style="background:#000;color:#fff;font:16px system-ui;margin:48px auto;max-width:360px;padding:0 16px">
<h1 style="font-size:20px">Sign in to Aurral as</h1>
${Object.entries(PEOPLE)
  .map(([person, { name, groups }]) => {
    const link = new URLSearchParams(query);
    link.set("person", person);
    return `<p><a style="color:#fff" href="/approve?${link.toString().replaceAll("&", "&amp;")}">${name}</a>, in ${groups.join(", ")}</p>`;
  })
  .join("\n")}
</body>`;

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", ISSUER);
  const query = url.searchParams;
  if (url.pathname === "/.well-known/openid-configuration") {
    return json(response, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      scopes_supported: ["openid", "profile", "email", "groups"],
    });
  }
  if (url.pathname === "/jwks") {
    return json(response, {
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: KEY_ID, use: "sig", alg: "RS256" }],
    });
  }
  if (url.pathname === "/authorize") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(page(query));
  }
  if (url.pathname === "/approve") {
    const person = query.get("person");
    const target = URL.parse(query.get("redirect_uri") ?? "");
    if (!isPerson(person) || !target) return json(response, { error: "invalid_request" }, 400);
    const code = randomUUID();
    codes.set(code, { person, nonce: query.get("nonce"), client: query.get("client_id") });
    target.searchParams.set("code", code);
    const state = query.get("state");
    if (state) target.searchParams.set("state", state);
    response.writeHead(302, { location: target.href });
    return response.end();
  }
  if (url.pathname === "/token" && request.method === "POST") {
    const form = new URLSearchParams(await text(request));
    const grant = codes.get(form.get("code") ?? "");
    if (!grant) return json(response, { error: "invalid_grant" }, 400);
    codes.delete(form.get("code") ?? "");
    const accessToken = randomUUID();
    tokens.set(accessToken, grant.person);
    return json(response, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken(grant.person, grant.nonce, grant.client),
    });
  }
  if (url.pathname === "/userinfo") {
    const person = tokens.get((request.headers.authorization ?? "").replace(/^Bearer /i, ""));
    return person
      ? json(response, claims(person))
      : json(response, { error: "invalid_token" }, 401);
  }
  if (url.pathname === "/health") return json(response, { issuer: ISSUER });
  json(response, { error: "not_found" }, 404);
}).listen(PORT, () => console.log(`Eden sign-in: ${ISSUER} on :${PORT}`));
