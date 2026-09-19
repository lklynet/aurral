import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { playlistSource } from "./weeklyFlowPlaylistSource.js";

const ENTRY = fileURLToPath(new URL("./weeklyFlowPlanProcess.js", import.meta.url));
const PLAN_TIMEOUT_MS = 30 * 60 * 1000;

export function createFlowPlanRunner({ forkProcess = fork, timeoutMs = PLAN_TIMEOUT_MS } = {}) {
  return function buildFlowRunPlan(flow, options = {}) {
    if (process.env.NODE_ENV === "test") {
      return playlistSource.buildFlowRunPlan(flow, options);
    }
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = forkProcess(ENTRY, [], {
          env: {
            ...process.env,
            AURRAL_BACKGROUND_WORKER_GROUP: "",
            AURRAL_FLOW_PLANNER: "1",
          },
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          execArgv: process.execArgv.filter((arg) =>
            !/^--(?:watch|watch-path|inspect|inspect-brk|test(?:-.*)?|experimental-test-.*)(?:=|$)/.test(arg)),
        });
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      const finish = (error, plan, acknowledge = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("message", onMessage);
        child.removeListener("exit", onExit);
        if (acknowledge && child.exitCode === null && child.signalCode === null) {
          const exitTimer = setTimeout(() => {
            try { child.kill(); } catch {}
          }, 5000);
          exitTimer.unref?.();
          child.once("exit", () => {
            clearTimeout(exitTimer);
            child.removeListener("error", onError);
          });
          try {
            child.send({ type: "flow-plan-ack" }, (sendError) => {
              if (!sendError) return;
              clearTimeout(exitTimer);
              try { child.kill(); } catch {}
            });
          } catch {
            clearTimeout(exitTimer);
            try { child.kill(); } catch {}
          }
        } else {
          child.removeListener("error", onError);
        }
        if (error) reject(error);
        else resolve(plan);
        if (!acknowledge && child.exitCode === null && child.signalCode === null) {
          try { child.kill(); } catch {}
        }
      };
      const onMessage = (message) => {
        if (message?.type === "flow-plan-result") finish(null, message.plan, true);
        if (message?.type === "flow-plan-error") {
          finish(new Error(message.error || "Flow planning failed"), null, true);
        }
      };
      const onError = (error) => finish(error);
      const onExit = (code, signal) =>
        finish(new Error(`Flow planner exited before returning a plan (${signal || code})`));
      const timer = setTimeout(() => {
        finish(new Error("Flow planning timed out"));
      }, timeoutMs);
      child.on("message", onMessage);
      child.on("error", onError);
      child.once("exit", onExit);
      try {
        child.send({ type: "build-flow-plan", flow, options });
      } catch (error) {
        finish(error);
      }
    });
  };
}

export const buildFlowRunPlanIsolated = createFlowPlanRunner();
