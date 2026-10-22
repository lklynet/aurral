import { dbOps } from "../../db/helpers/index.ts";

if (!process.send) {
  throw new Error("Flow planner requires a supervised parent process");
}

let awaitingAcknowledgement = false;
let resultExitCode = 0;

process.on("message", async (message) => {
  if (message?.type === "flow-plan-ack" && awaitingAcknowledgement) {
    process.exit(resultExitCode);
  }
  if (message?.type !== "build-flow-plan") return;
  try {
    dbOps.invalidateSettingsCache();
    const { reloadDiscoveryPersistedCache } = await import("../discovery/persistence.ts");
    reloadDiscoveryPersistedCache();
    const { flowTrackSource } = await import("./flowTrackSource.ts");
    const plan = await flowTrackSource.buildFlowRunPlan(message.flow, message.options);
    resultExitCode = 0;
    awaitingAcknowledgement = true;
    process.send({ type: "flow-plan-result", plan });
  } catch (error) {
    resultExitCode = 1;
    awaitingAcknowledgement = true;
    process.send({ type: "flow-plan-error", error: error?.message || String(error) });
  }
});

process.once("disconnect", () => process.exit(1));
