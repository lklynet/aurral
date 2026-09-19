import { dbOps } from "../../db/helpers/index.js";

if (!process.send) {
  throw new Error("Flow planner requires a supervised parent process");
}

process.once("message", async (message) => {
  if (message?.type !== "build-flow-plan") return;
  try {
    dbOps.invalidateSettingsCache();
    const { reloadDiscoveryPersistedCache } = await import("../discovery/persistence.js");
    reloadDiscoveryPersistedCache();
    const { playlistSource } = await import("./weeklyFlowPlaylistSource.js");
    const plan = await playlistSource.buildFlowRunPlan(message.flow, message.options);
    process.send({ type: "flow-plan-result", plan }, () => process.exit(0));
  } catch (error) {
    process.send({ type: "flow-plan-error", error: error?.message || String(error) },
      () => process.exit(1));
  }
});

process.once("disconnect", () => process.exit(1));
