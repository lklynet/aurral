import { getApiErrorBody } from "./api/errors.ts";
import { asApiError } from "./api/core.ts";
import { parseResponse } from "hono/client";
import { authClient } from "./api/clients/auth.ts";
import { usersClient } from "./api/clients/users.ts";
import { continueOnServer, HOSTED } from "./server.ts";

export const isReauthRequiredError = (err: unknown) =>
  asApiError(err)?.response?.status === 401 && getApiErrorBody(err)?.error === "reauth_required";

export async function promptReauth() {
  if (HOSTED) {
    const identities = await parseResponse(usersClient.me.identities.$get()).catch(() => null);
    if (identities?.hasLocalPassword === false) {
      continueOnServer();
      return false;
    }
  }
  const password = window.prompt("Enter your password to continue:");
  if (!password) return false;
  try {
    await parseResponse(authClient.reauth.$post({ json: { currentPassword: password } }));
    return true;
  } catch (err) {
    const body = getApiErrorBody(err);
    window.alert(
      body?.error === "no_local_password"
        ? body.message || "This account has no local password. Sign out and back in to continue."
        : "That password wasn't correct.",
    );
    return false;
  }
}
