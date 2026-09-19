let requester = null;
let statusReader = () => null;
const pending = new Map();
let nextRequestId = 0;
let listening = false;

export function isFlowOwnerProcess() {
  return process.env.NODE_ENV === "test" ||
    process.env.AURRAL_TEST_SERVER === "1" ||
    process.env.AURRAL_BACKGROUND_WORKER_GROUP === "flow";
}

export function configureFlowOwnerClient({ request, getStatus }) {
  requester = request;
  statusReader = getStatus;
}

export function getFlowOwnerStatus() {
  return statusReader?.() || null;
}

export function requestFlowOwner(method, args = [], { timeoutMs = 30000 } = {}) {
  if (requester) return requester(method, args, { timeoutMs });
  if (!process.env.AURRAL_BACKGROUND_WORKER_GROUP || !process.connected || !process.send) {
    return Promise.reject(new Error("Flow worker is not ready"));
  }
  if (!listening) {
    listening = true;
    process.on("message", (message) => {
      if (message?.type !== "flow-client-response") return;
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    });
  }
  return new Promise((resolve, reject) => {
    const requestId = ++nextRequestId;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Flow worker request timed out: ${method}`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try {
      process.send({ type: "flow-client-request", requestId, method, args, timeoutMs });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}
