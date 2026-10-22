import type { Request, Response } from "express";
import { validateExternalUrl } from "../../middleware/urlValidator.ts";
import { NavidromeClient } from "../../services/navidrome.ts";
import { stripTrailingSlashes } from "../../services/textUtils.ts";
import { asAppError } from "../../../lib/errors.ts";

export async function testNavidromeConnection(req: Request, res: Response) {
  try {
    const url = stripTrailingSlashes(String(req.body?.url || "").trim());
    const username = String(req.body?.username || "").trim();
    const password = req.body?.password ?? "";
    if (!url || !username || !password) {
      return res.status(400).json({ error: "URL, username, and password are required" });
    }
    const validation = validateExternalUrl(url);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    await new NavidromeClient(validation.url, username, password).ping();
    return res.json({ success: true, message: "Connection successful" });
  } catch (error) {
    const failure = asAppError(error);
    return res.status(400).json({
      error: "Connection failed",
      message: failure?.message,
    });
  }
}
