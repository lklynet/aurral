import { parseResponse } from "hono/client";
import { authClient } from "./api/clients/auth.ts";
import { invalidateBootstrapCache } from "./appHealth.ts";

export const logIn = async (username: string | undefined, password: string) => {
  const result = await parseResponse(authClient.login.$post({ json: { username, password } }));
  invalidateBootstrapCache();
  return result;
};

export const logOut = async () => {
  await parseResponse(authClient.logout.$post());
  invalidateBootstrapCache();
};
