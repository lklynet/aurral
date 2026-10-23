import type { DownloadWorker } from "./downloadWorker.ts";
import type { JsonValue } from "@russellthehippo/honker-node";

export type DownloadOwnerStatus = ReturnType<DownloadWorker["getStatus"]> & {
  operationWorker: { running: boolean; currentLabel: JsonValue };
};

type DownloadOwnerRequester = (
  method: string,
  args: unknown[],
  options: { timeoutMs: number },
) => Promise<unknown>;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OwnerClientResponse {
  type: "download-owner-client-response";
  requestId: number;
  result?: unknown;
  error?: string;
}

function isOwnerClientResponse(message: unknown): message is OwnerClientResponse {
  return (
    typeof message === "object" &&
    message !== null &&
    Reflect.get(message, "type") === "download-owner-client-response"
  );
}

let requester: DownloadOwnerRequester | null = null;
let statusReader: () => DownloadOwnerStatus | null = () => null;
const pending = new Map<number, PendingRequest>();
let nextRequestId = 0;
let listening = false;

export function isDownloadOwnerProcess() {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.AURRAL_TEST_SERVER === "1" ||
    process.env.AURRAL_BACKGROUND_WORKER_GROUP === "downloads"
  );
}

export function configureDownloadOwnerClient({
  request,
  getStatus,
}: {
  request: DownloadOwnerRequester | null;
  getStatus: () => DownloadOwnerStatus | null;
}) {
  requester = request;
  statusReader = getStatus;
}

export function getDownloadOwnerStatus() {
  return statusReader?.() || null;
}

export function requestDownloadOwner<T = unknown>(
  method: string,
  args: unknown[] = [],
  { timeoutMs = 30000 }: { timeoutMs?: number } = {},
): Promise<T> {
  if (requester) return requester(method, args, { timeoutMs }) as Promise<T>;
  if (!process.env.AURRAL_BACKGROUND_WORKER_GROUP || !process.connected || !process.send) {
    return Promise.reject(new Error("Download worker is not ready"));
  }
  if (!listening) {
    listening = true;
    process.on("message", (message) => {
      if (!isOwnerClientResponse(message)) return;
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    });
  }
  return new Promise<unknown>((resolve, reject) => {
    const requestId = ++nextRequestId;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Download worker request timed out: ${method}`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try {
      process.send!({ type: "download-owner-client-request", requestId, method, args, timeoutMs });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  }) as Promise<T>;
}
