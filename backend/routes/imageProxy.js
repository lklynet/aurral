import express from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import { handleImageCacheRequest, handleImageProxyRequest } from "../services/imageProxyService.js";

const router = express.Router();

router.post("/", requireAuth, handleImageCacheRequest);
router.get("/:cacheKey", handleImageProxyRequest);

export default router;
