import { local, type Service } from "./service.ts";

const ADMIN_GROUP = "admins";

// Both ways of signing in through another system: an OpenID Connect provider, and a
// reverse proxy that names the user in a header.
export const sso: Service = {
  containers: ["oidc"],
  about: (ports) =>
    `${local(ports.oidc)} signs in Ada (admin) or Grace; a Remote-User header signs in anyone`,
  env: (ports) => ({
    OIDC_ENABLED: "true",
    OIDC_ISSUER: local(ports.oidc),
    OIDC_CLIENT_ID: "aurral",
    OIDC_CLIENT_SECRET: "eden",
    OIDC_REDIRECT_URI: `${local(ports.aurralWeb)}/sso/callback`,
    OIDC_GROUPS_CLAIM: "groups",
    OIDC_ADMIN_GROUPS: ADMIN_GROUP,
    AUTH_PROXY_ENABLED: "true",
    AUTH_PROXY_HEADER: "Remote-User",
    AUTH_PROXY_ROLE_HEADER: "Remote-Groups",
    AUTH_PROXY_ADMIN_GROUPS: ADMIN_GROUP,
    AUTH_PROXY_TRUSTED_IPS: "127.0.0.1",
  }),
  async setup() {},
};
