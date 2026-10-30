import { logger } from "../services/logger.ts";
import { resolveAurralDataDir, resolveAurralDbPath } from "./data-dir.ts";
import { applyStagedRestore } from "./stagedRestore.ts";

const previous = applyStagedRestore(resolveAurralDataDir(), resolveAurralDbPath());
if (previous) logger.info("system", `Restored a backup. The previous data is in ${previous}`);
