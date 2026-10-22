import { closeHonkerDb, restoreReleaseMetadataQueueForRollback } from "../services/honkerDb.ts";
import { db } from "../config/db-sqlite.ts";

try {
  const moved = restoreReleaseMetadataQueueForRollback();
  console.log(`Restored ${moved} pending metadata jobs to the system queue.`);
} finally {
  closeHonkerDb();
  db.close();
}
