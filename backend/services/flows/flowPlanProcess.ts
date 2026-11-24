import { asAppError } from "../../../lib/errors.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { reloadDiscoveryPersistedCache } from "../discovery/persistence.ts";
import { flowTrackSource } from "./flowTrackSource.ts";
import { trackWork } from "../eventLoopWatch.ts";
import type { FlowPlanParentMessage } from "./flowPlanRunner.ts";

if (!process.send) {
  throw new Error("Flow planner requires a supervised parent process");
}

let awaitingAcknowledgement = false;
let resultExitCode = 0;

process.on("message", async (received) => {
  const message = received as FlowPlanParentMessage | null;
  if (message?.type === "flow-plan-ack" && awaitingAcknowledgement) {
    process.exit(resultExitCode);
  }
  if (message?.type !== "build-flow-plan") return;
  try {
    dbOps.invalidateSettingsCache();
    reloadDiscoveryPersistedCache();
    const plan = await trackWork(
      () => "flow-plan",
      () => flowTrackSource.buildFlowRunPlan(message.flow),
    );
    resultExitCode = 0;
    awaitingAcknowledgement = true;
    process.send!({ type: "flow-plan-result", plan });
  } catch (error) {
    const failure = asAppError(error);
    resultExitCode = 1;
    awaitingAcknowledgement = true;
    process.send!({ type: "flow-plan-error", error: failure?.message || String(error) });
  }
});

process.once("disconnect", () => process.exit(1));
