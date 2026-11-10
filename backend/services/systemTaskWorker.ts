import { createJobWorker, type TypedJob } from "./jobs/worker.ts";
import {
  SYSTEM_TASK_QUEUES,
  systemTask,
  systemTaskSchema,
  type SystemTask,
} from "./jobs/systemTasks.ts";

type RunContext = Omit<Parameters<ReturnType<typeof systemTask>["run"]>[1], "job">;

export async function processSystemTask(
  payload: SystemTask,
  job: TypedJob<SystemTask> | null = null,
  context: RunContext = {},
) {
  return systemTask(payload.kind).run(payload, { job, ...context });
}

const workers = new Map(
  SYSTEM_TASK_QUEUES.map((queue) => [
    queue.name,
    createJobWorker(queue, {
      schema: systemTaskSchema,
      processJob: processSystemTask,
      prepareJob: (payload, _job, context) => systemTask(payload.kind).prepare?.(context) ?? null,
      interruptible: (payload) => systemTask(payload.kind).interruptible === true,
      onJobSuccess(payload) {
        const cache = systemTask(payload.kind).invalidates;
        if (cache && process.connected && process.send) {
          process.send({ type: "cache-invalidate", cache });
        }
      },
    }),
  ]),
);

export function startSystemTaskWorker(name: string) {
  return workers.get(name)?.start();
}
