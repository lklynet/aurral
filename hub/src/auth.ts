import { betterAuth, type BetterAuthOptions } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import type { Bindings } from "./index.ts";

export const identityEmail = (provider: string, id: string) => `${provider}-${id}@users.aurral.org`;

const asIdentity = (provider: string, id: string) => ({
  email: identityEmail(provider, id),
  emailVerified: true,
  name: "",
  image: undefined,
});

const withoutTokens = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scope: null,
};

const configured = (id: string | undefined, secret: string | undefined) =>
  id && secret ? { clientId: id, clientSecret: secret } : null;

export function socialProviders(env: Bindings) {
  const github = configured(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
  const discord = configured(env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET);
  return {
    ...(github && {
      github: {
        ...github,
        disableDefaultScope: true,
        scope: ["read:user"],
        mapProfileToUser: (profile: { id: string }) => asIdentity("github", String(profile.id)),
      },
    }),
    ...(discord && {
      discord: {
        ...discord,
        disableDefaultScope: true,
        scope: ["identify"],
        mapProfileToUser: (profile: { id: string }) => asIdentity("discord", profile.id),
      },
    }),
  };
}

const edenProvider = (issuer: string | undefined) =>
  genericOAuth({
    config: issuer
      ? [
          {
            providerId: "eden",
            clientId: "aurral",
            clientSecret: "eden",
            discoveryUrl: `${issuer}/.well-known/openid-configuration`,
            scopes: ["openid"],
            mapProfileToUser: (profile) => asIdentity("eden", String(profile.id)),
          },
        ]
      : [],
  });

export const authOptions = (env: Bindings) =>
  ({
    database: env.DB,
    baseURL: env.HUB_ORIGIN,
    basePath: "/v1/auth",
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.HUB_ORIGIN],
    disabledPaths: ["/link-social", "/unlink-account", "/update-user"],
    user: {
      modelName: "accounts",
      fields: { emailVerified: "email_verified", createdAt: "created_at", updatedAt: "updated_at" },
    },
    account: {
      modelName: "identities",
      updateAccountOnSignIn: false,
      fields: {
        accountId: "provider_account_id",
        providerId: "provider",
        userId: "account_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "sessions",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "account_id",
      },
    },
    verification: {
      modelName: "verifications",
      fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
    },
    advanced: { ipAddress: { disableIpTracking: true } },
    databaseHooks: {
      account: {
        create: { before: async (identity) => ({ data: { ...identity, ...withoutTokens } }) },
        update: { before: async (identity) => ({ data: { ...identity, ...withoutTokens } }) },
      },
      session: {
        create: { before: async (session) => ({ data: { ...session, userAgent: null } }) },
      },
    },
    socialProviders: socialProviders(env),
    plugins: [edenProvider(env.EDEN_OIDC_ISSUER)],
  }) satisfies BetterAuthOptions;

const instances = new WeakMap<Bindings, ReturnType<typeof createAuth>>();

const createAuth = (env: Bindings) => betterAuth(authOptions(env));

export function authFor(env: Bindings) {
  let auth = instances.get(env);
  if (!auth) instances.set(env, (auth = createAuth(env)));
  return auth;
}
