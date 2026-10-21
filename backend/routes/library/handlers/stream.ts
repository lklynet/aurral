import type { Router } from "express";
import axios from "../../../../lib/axiosFetch.ts";
import { noCache } from "../../../middleware/cache.ts";
import { verifyTokenAuth } from "../../../middleware/auth.ts";
import { dbOps } from "../../../db/helpers/index.ts";

export function registerStream(router: Router) {
  router.get("/stream/:songId", noCache, async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { songId } = req.params;
    const settings = dbOps.getSettings();
    const nd = settings.integrations?.navidrome;
    if (!nd?.url || !nd?.username || !nd?.password) {
      return res.status(503).json({ error: "Navidrome not configured" });
    }
    try {
      const { NavidromeClient } = await import("../../../services/navidrome.ts");
      const client = new NavidromeClient(nd.url, nd.username, nd.password);
      const streamUrl = client.getStreamUrl(songId);
      const response = await axios.get(streamUrl, {
        responseType: "stream",
        timeout: 30000,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      const contentType = response.headers["content-type"];
      if (contentType) res.setHeader("Content-Type", contentType);
      const contentLength = response.headers["content-length"];
      if (contentLength) res.setHeader("Content-Length", contentLength);
      response.data.pipe(res);
    } catch (error) {
      const status = error.response?.status || 500;
      if (!res.headersSent) {
        res.status(status).json({
          error: "Stream failed",
          message: error.message,
        });
      }
    }
  });
}
