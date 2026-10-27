import { getApiErrorBody } from "../pages/onboardingUtils.tsx";
import { asApiError } from "./api/core.ts";
import { parseResponse } from "hono/client";
import { authClient } from "./api/clients/auth.ts";

export const isReauthRequiredError = (err: unknown) =>
  asApiError(err)?.response?.status === 401 && getApiErrorBody(err)?.error === "reauth_required";

export async function promptReauth() {
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
