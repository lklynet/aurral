import type { Context } from "hono";
import type { CredentialRequest } from "../../middleware/auth.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";

export const requestCredentials = <E extends AppEnv>(c: Context<E>): CredentialRequest => {
  const apiKeys = c.req.queries("api_key");
  return {
    headers: c.req.header(),
    query: { api_key: apiKeys?.length === 1 ? apiKeys[0] : undefined },
    ip: c.var.clientIp,
    ips: c.var.clientIps,
  };
};
