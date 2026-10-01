import { getArtistByMbid } from "../../backend/services/providers/brainzmashProvider.js";
import { db } from "../../backend/config/db-sqlite.js";
process.on("message", async (message) => {
  if (message.type === "request") {
    try {
      await getArtistByMbid(message.mbid);
      process.send({ type: "result", ok: true });
    } catch (error) {
      process.send({ type: "result", code: error.code });
    }
  }
  if (message.type === "shutdown") {
    db.close();
    process.exit(0);
  }
});
process.send({ type: "ready" });
