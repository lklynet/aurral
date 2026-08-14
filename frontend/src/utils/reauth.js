import { reauthApi } from "./api/endpoints/auth.js";

export const isReauthRequiredError = (err) =>
  err?.response?.status === 401 && err?.response?.data?.error === "reauth_required";

// Prompts for the current password and refreshes the session's recent-auth
// timestamp. Returns true if the caller should retry the action that failed.
export async function promptReauth() {
  const password = window.prompt("Please re-enter your password to continue:");
  if (!password) return false;
  try {
    await reauthApi(password);
    return true;
  } catch {
    window.alert("That password wasn't correct.");
    return false;
  }
}
