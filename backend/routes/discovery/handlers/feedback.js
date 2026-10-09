import { requireAuth } from "../../../middleware/requirePermission.js";
import {
  getDiscoveryFeedback,
  addDiscoveryFeedback,
  removeDiscoveryFeedback,
  restoreDiscoveryFeedback,
  resetDiscoveryFeedback,
} from "../../../services/discovery/index.js";

export function registerFeedback(router) {
  router.get("/feedback", requireAuth, (req, res) => {
    res.json({
      feedback: getDiscoveryFeedback(req.user.id),
    });
  });

  router.post("/feedback", requireAuth, (req, res) => {
    try {
      const feedback = addDiscoveryFeedback(req.user.id, req.body || {});
      res.json({
        success: true,
        feedback,
        feedbackList: getDiscoveryFeedback(req.user.id),
      });
    } catch (error) {
      res.status(400).json({
        error: "Failed to save discovery feedback",
        message: error.message,
      });
    }
  });

  router.delete("/feedback/:id", requireAuth, (req, res) => {
    const feedbackList = removeDiscoveryFeedback(req.user.id, req.params.id);
    res.json({
      success: true,
      feedbackList,
    });
  });

  router.post("/feedback/restore", requireAuth, (req, res) => {
    const { removeIds = [], entries = [] } = req.body || {};
    if (!Array.isArray(removeIds) || !Array.isArray(entries) || removeIds.length + entries.length === 0) {
      return res.status(400).json({
        error: "Failed to restore discovery feedback",
        message: "removeIds or entries is required",
      });
    }
    res.json({
      success: true,
      feedbackList: restoreDiscoveryFeedback(req.user.id, { removeIds, entries }),
    });
  });

  router.post("/feedback/reset", requireAuth, (req, res) => {
    const feedbackList = resetDiscoveryFeedback(req.user.id);
    res.json({
      success: true,
      feedbackList,
    });
  });
}
