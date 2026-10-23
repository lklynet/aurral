import { getArtistByMbid } from "../../backend/services/providers/brainzmashProvider.ts";
import { db } from "../../backend/config/db-sqlite.ts";
type ParentMessage = { type: "request"; mbid: string } | { type: "shutdown" };

process.on("message", async (message: ParentMessage) => {
  if (message.type === "request") {
    try {
      await getArtistByMbid(message.mbid);
      process.send?.({ type: "result", ok: true });
    } catch (error) {
      process.send?.({ type: "result", code: (error as NodeJS.ErrnoException).code });
    }
  }
  if (message.type === "shutdown") {
    db.close();
    process.exit(0);
  }
});
process.send?.({ type: "ready" });
