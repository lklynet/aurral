import type { IncomingMessage, ServerResponse } from "node:http";
import { create as contentDisposition } from "content-disposition";
import { Hono } from "hono";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth, requireRecentAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { BackupError, createBackup, stageRestore } from "../services/appBackup.ts";
import { logger } from "../services/logger.ts";
import { zipStream } from "../services/zip.ts";
import { sendViaNode } from "./shared/sendViaNode.ts";

type Backup = Awaited<ReturnType<typeof createBackup>>;

async function sendBackup(_req: IncomingMessage, res: ServerResponse, backup: Backup) {
  if (res.destroyed) {
    await backup.release();
    return true;
  }
  res.setHeader("Content-Length", String(backup.plan.totalSize));
  const body = zipStream(backup.plan);
  body.on("error", (error) => {
    logger.warn("system", "Backup download stopped:", { message: error.message });
    res.destroy(error);
  });
  res.on("close", () => {
    body.destroy();
    void backup.release();
  });
  body.pipe(res);
  return true;
}

export default new Hono<AppEnv>()
  .basePath("/backup")
  .use(requireAuth, requireAdmin)
  .get("/", requireRecentAuth(), noCache, async (c) => {
    try {
      const backup = await createBackup();
      const date = new Date().toISOString().slice(0, 10);
      c.header("Content-Type", "application/zip");
      c.header("Content-Disposition", contentDisposition(`aurral-backup-${date}.zip`));
      return (await sendViaNode(c, sendBackup, backup)) ?? c.json({ error: "Backup failed" }, 500);
    } catch (error) {
      if (error instanceof BackupError) return c.json({ error: error.message }, 400);
      throw error;
    }
  })
  .post("/restore", async (c) => {
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "Choose a backup file to restore." }, 400);
    try {
      await stageRestore(body);
    } catch (error) {
      if (error instanceof BackupError) return c.json({ error: error.message }, 400);
      throw error;
    }
    c.env.outgoing.once("finish", () => process.kill(process.pid, "SIGTERM"));
    return c.json({ restarting: true }, 202);
  });
