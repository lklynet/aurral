export function createNotify({ gotifyToken }) {
  const state = { messages: [], hooks: [], nextMessageId: 1 };

  const handler = ({ method, url, headers, body }) => {
    if (method === "GET" && url.pathname === "/version") {
      return { status: 200, body: { version: "2.6.1-lab", commit: "lab", buildDate: "2026-01-01T00:00:00Z" } };
    }
    if (method === "POST" && url.pathname === "/message") {
      const token = url.searchParams.get("token") || headers["x-gotify-key"];
      if (token !== gotifyToken) {
        return { status: 401, body: { error: "Unauthorized", errorCode: 401, errorDescription: "you need to provide a valid access token or user credentials to access this api" } };
      }
      if (!body?.message) return { status: 400, body: { error: "Bad Request", errorCode: 400, errorDescription: "Field 'message' is required" } };
      const message = { id: state.nextMessageId++, appid: 1, title: body.title || "", message: body.message, priority: Number(body.priority ?? 5), date: new Date().toISOString() };
      state.messages.push(message);
      return { status: 200, body: message };
    }
    const hook = /^\/hooks\/([\w-]+)$/.exec(url.pathname);
    if (hook) {
      state.hooks.push({ name: hook[1], method, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key === "content-type" || key.startsWith("x-"))), body: body ?? null, at: new Date().toISOString() });
      return { status: 200, body: { received: true } };
    }
    return null;
  };
  handler.state = state;
  handler.restore = (saved) => Object.assign(state, saved);
  return handler;
}
