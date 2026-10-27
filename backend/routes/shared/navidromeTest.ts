import * as v from "valibot";
import { validateExternalUrl } from "../../middleware/urlValidator.ts";
import { NavidromeClient } from "../../services/navidrome.ts";
import { stripTrailingSlashes } from "../../services/textUtils.ts";
import { asAppError } from "../../../lib/errors.ts";

export const navidromeTestBody = v.object({
  url: v.optional(v.string()),
  username: v.optional(v.string()),
  password: v.optional(v.string()),
});

export async function navidromeConnectionError(
  input: v.InferOutput<typeof navidromeTestBody>,
): Promise<{ error: string; message?: string } | null> {
  try {
    const url = stripTrailingSlashes((input.url || "").trim());
    const username = (input.username || "").trim();
    const password = input.password ?? "";
    if (!url || !username || !password) {
      return { error: "URL, username, and password are required" };
    }
    const validation = validateExternalUrl(url);
    if (!validation.valid) return { error: validation.error };

    await new NavidromeClient(validation.url, username, password).ping();
    return null;
  } catch (error) {
    return { error: "Connection failed", message: asAppError(error)?.message };
  }
}
