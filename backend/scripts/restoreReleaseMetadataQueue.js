import { closeHonkerDb, restoreReleaseMetadataQueueForRollback } from "../services/honkerDb.js";
import { db } from "../config/db-sqlite.js";

try {
  const moved = restoreReleaseMetadataQueueForRollback();
  console.log(`Restored ${moved} pending metadata jobs to the system queue.`);
} finally {
  closeHonkerDb();
  db.close();
}
