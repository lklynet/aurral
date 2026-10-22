import express from "express";
import {
  buildFlowLidarrImportList,
  verifyFlowLidarrFeedToken,
} from "../services/lidarrImportListFeed.ts";

const router = express.Router();

router.get("/lidarr/flows/:flowId.json", (req, res) => {
  const flowId = String(req.params.flowId || "").trim();
  const token = String(req.query.token || "").trim();
  if (!flowId || !verifyFlowLidarrFeedToken(flowId, token)) {
    return res.status(404).json({ error: "Not found" });
  }
  const items = buildFlowLidarrImportList(flowId);
  if (!items) {
    return res.status(404).json({ error: "Not found" });
  }
  res.set("Cache-Control", "public, max-age=300");
  res.json(items);
});

export default router;
