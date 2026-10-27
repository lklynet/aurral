import type { Context } from "hono";
import type { CredentialRequest } from "../../middleware/auth.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";

export const requestCredentials = <E extends AppEnv>(c: Context<E>): CredentialRequest => {
  const single = (name: string) => {
    const values = c.req.queries(name);
    return values?.length === 1 ? values[0] : undefined;
  };
  return {
    headers: c.req.header(),
    query: { api_key: single("api_key"), token: single("token"), st: single("st") },
    ip: c.var.clientIp,
    ips: c.var.clientIps,
  };
};
