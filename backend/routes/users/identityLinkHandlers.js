import { userOps, userIdentityOps } from "../../db/helpers/index.js";
import { requireAuth, requireRecentAuth } from "../../middleware/requirePermission.js";

export function registerIdentityLink(router) {
  router.get("/me/identities", requireAuth, (req, res) => {
    const user = userOps.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({
      hasLocalPassword: user.hasLocalPassword,
      identities: userIdentityOps.getForUser(req.user.id).map((identity) => ({
        id: identity.id,
        providerType: identity.providerType,
        providerKey: identity.providerKey,
        displayName: identity.displayName,
        linkedAt: identity.linkedAt,
      })),
    });
  });

  router.delete("/me/identities/:id", requireAuth, requireRecentAuth(), (req, res) => {
    const identityId = parseInt(req.params.id, 10);
    const identity = userIdentityOps.getById(identityId);
    if (!identity || identity.userId !== req.user.id) {
      return res.status(404).json({ error: "Identity not found" });
    }

    const user = userOps.getUserById(req.user.id);
    const remaining = userIdentityOps.countForUser(req.user.id) - 1;
    if (remaining <= 0 && !user?.hasLocalPassword) {
      return res.status(400).json({
        error: "last_auth_method",
        message:
          "This is your only way to sign in. Set a local password or link another account before removing it.",
      });
    }

    userIdentityOps.unlink(identityId);
    res.json({ success: true });
  });
}
