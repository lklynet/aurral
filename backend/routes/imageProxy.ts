import express from "express";
import { requireAuth } from "../middleware/requirePermission.ts";
import { handleImageCacheRequest, handleImageProxyRequest } from "../services/imageProxyService.ts";

const router = express.Router();

router.post("/", requireAuth, handleImageCacheRequest);
router.get("/:cacheKey", handleImageProxyRequest);

export default router;
