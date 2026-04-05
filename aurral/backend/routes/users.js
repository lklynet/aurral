import express from "express";
import bcrypt from 'bcrypt';
import { userOps } from "../config/db-helpers.js";
import { requireAuth, requireAdmin } from "../middleware/requirePermission.js";
import { requirePasswordStrength } from "../middleware/validation.js";
import { deleteSessionsByUserId } from "../config/session-helpers.js";

const router = express.Router();

router.get("/", requireAuth, requireAdmin, (req, res) => {
  try {
    const users = userOps.getAllUsers();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: "Failed to list users", message: e.message });
  }
});

router.post("/", requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password, role = "user", permissions } = req.body;
    const un = String(username || "").trim();
    if (!un || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    if (userOps.getUserByUsername(un)) {
      return res.status(409).json({ error: "Username already exists" });
    }
    const passwordValidation = requirePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }
    const hash = bcrypt.hashSync(password, 10);
    const perms = permissions
      ? { ...userOps.getDefaultPermissions(), ...permissions }
      : null;
    const created = userOps.createUser(un, hash, role, perms);
    if (!created) {
      return res.status(500).json({ error: "Failed to create user" });
    }
    res
      .status(201)
      .json({
        id: created.id,
        username: created.username,
        role: created.role,
        permissions: created.permissions,
      });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to create user", message: e.message });
  }
});

router.patch("/:id", requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const isAdmin = req.user.role === "admin";
    const isSelf = req.user.id === id;
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const existing = userOps.getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }
    const { password, permissions, role } = req.body;
    if (isSelf && !isAdmin) {
      if (permissions !== undefined || role !== undefined) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const { currentPassword } = req.body;
      if (!password || !currentPassword) {
        return res
          .status(400)
          .json({ error: "currentPassword and password required" });
      }
      if (!bcrypt.compareSync(currentPassword, existing.passwordHash)) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
      const passwordValidation = requirePasswordStrength(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
      const hash = bcrypt.hashSync(password, 10);
      userOps.updateUser(id, { passwordHash: hash });
      deleteSessionsByUserId(id);
      return res.json({ id, username: existing.username, role: existing.role });
    }
    const updates = {};
    if (password) {
      const passwordValidation = requirePasswordStrength(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
      updates.passwordHash = bcrypt.hashSync(password, 10);
    }
    if (permissions !== undefined) updates.permissions = permissions;
    if (role !== undefined) updates.role = role;
    if (Object.keys(updates).length === 0) {
      return res.json({
        id: existing.id,
        username: existing.username,
        role: existing.role,
        permissions: existing.permissions,
      });
    }
    const updated = userOps.updateUser(id, updates);
    res.json(updated);
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to update user", message: e.message });
  }
});

router.post("/me/password", requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: "New password required" });
    }
    const passwordValidation = requirePasswordStrength(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }
    const u = userOps.getUserById(req.user.id);
    if (!u || !bcrypt.compareSync(currentPassword || "", u.passwordHash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    userOps.updateUser(req.user.id, { passwordHash: hash });
    deleteSessionsByUserId(req.user.id);
    res.json({ success: true });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to change password", message: e.message });
  }
});

router.delete("/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (req.user.id === id) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }
    const existing = userOps.getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }
    deleteSessionsByUserId(id);
    userOps.deleteUser(id);
    res.json({ success: true });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to delete user", message: e.message });
  }
});

export default router;
