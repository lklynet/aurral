import { reauthApi } from "./api/endpoints/auth.js";

export const isReauthRequiredError = (err) =>
  err?.response?.status === 401 && err?.response?.data?.error === "reauth_required";

export async function promptReauth() {
  const password = window.prompt("Please re-enter your password to continue:");
  if (!password) return false;
  try {
    await reauthApi(password);
    return true;
  } catch (err) {
    window.alert(
      err?.response?.data?.error === "no_local_password"
        ? err.response.data.message ||
            "This account has no local password. Sign out and back in to continue."
        : "That password wasn't correct.",
    );
    return false;
  }
}
