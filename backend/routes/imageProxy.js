import express from "express";
import { handleImageProxyRequest } from "../services/imageProxyService.js";

const router = express.Router();

router.get("/:cacheKey", handleImageProxyRequest);

export default router;
