import {
  Agent,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type Response as UndiciResponse,
} from "undici";
import { resolvePublicUrl } from "./publicUrl.ts";
import { resolveAppVersion } from "./app-version.ts";

type FetchResponse = UndiciResponse | Response;

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  dispatcher: Dispatcher;
  body?: string | URLSearchParams | Uint8Array;
}

type NodeFetch = (url: string, init: FetchInit & { redirect: "manual" }) => Promise<FetchResponse>;

type HttpQuery = Record<string, string | number | boolean | null | undefined>;

export interface HttpOptions {
  method?: string;
  query?: HttpQuery;
  headers?: Record<string, string>;
  basicAuth?: { username?: string; password?: string };
  body?: unknown;
  timeoutMs?: number;
  bodyTimeoutMs?: number;
  signal?: AbortSignal;
  responseType?: "buffer";
  okStatus?: (status: number) => boolean;
  insecureTls?: boolean;
  publicOnly?: boolean;
  keepMethodOnRedirect?: boolean;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
}

export class HttpError extends Error {
  readonly method: string;
  readonly url: string;
  readonly response: HttpResponse | undefined;
  readonly code: string | undefined;

  constructor(
    message: string,
    request: { method: string; url: string },
    { response, code, cause }: { response?: HttpResponse; code?: string; cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = "HttpError";
    this.method = request.method;
    this.url = request.url;
    this.response = response;
    this.code = code;
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  "TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export const isTransientNetworkError = (error: unknown) =>
  error instanceof HttpError && !error.response && TRANSIENT_NETWORK_CODES.has(error.code ?? "");

type RequestFailure = {
  method: string;
  url: string;
  status: number | null;
  code: string | null;
  ms: number;
  message: string;
};

let reportFailure: ((failure: RequestFailure) => void) | null = null;

export function onRequestFailure(listener: (failure: RequestFailure) => void) {
  reportFailure = listener;
}

const usesNativeFetch = () =>
  Function.prototype.toString.call(globalThis.fetch).includes("internal/deps/undici");

function joinUrl(baseUrl: string | undefined, url: string) {
  if (!baseUrl || url.startsWith("http://") || url.startsWith("https://")) return url;
  if (!url) return baseUrl;
  return `${baseUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

function appendQuery(url: string, query: HttpQuery | undefined) {
  if (!query) return url;
  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function headersToObject(headers: FetchResponse["headers"]): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value: string, key: string) => {
    output[key] = value;
  });
  return output;
}

const defaultDispatcher = new Agent({
  connections: 16,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

let envProxyDispatcher: EnvHttpProxyAgent | null = null;

const insecureDispatcher = new Agent({
  connections: 16,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: { rejectUnauthorized: false },
});

function resolveDispatcher(options: HttpOptions) {
  if (options.insecureTls) return insecureDispatcher;
  if (process.env.NODE_USE_ENV_PROXY === "1") {
    envProxyDispatcher ||= new EnvHttpProxyAgent();
    return envProxyDispatcher;
  }
  return defaultDispatcher;
}

async function readBody(response: FetchResponse, options: HttpOptions) {
  if (options.responseType === "buffer") {
    return Buffer.from(await response.arrayBuffer());
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return response.text();
}

function basicAuthHeader(auth: HttpOptions["basicAuth"]) {
  if (!auth?.username && !auth?.password) return null;
  const encoded = Buffer.from(`${auth.username || ""}:${auth.password || ""}`).toString("base64");
  return `Basic ${encoded}`;
}

const APP_USER_AGENT = `Aurral/${resolveAppVersion({ envValue: process.env.APP_VERSION })}`;

const MAX_REDIRECTS = 5;
const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-gotify-key",
  "x-plex-token",
  "x-nd-authorization",
]);
const BODY_HEADERS = new Set(["content-length", "content-type", "transfer-encoding"]);

function removeHeaders(headers: Record<string, string>, names: Set<string>) {
  for (const name of Object.keys(headers)) {
    if (names.has(name.toLowerCase())) delete headers[name];
  }
}

async function createPublicDispatcher(url: string) {
  const { addresses } = await resolvePublicUrl(url);
  const lookup = (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (error: Error | null, address: string | typeof addresses, family?: number) => void,
  ) => {
    queueMicrotask(() => {
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
  return new Agent({ connections: 1, connect: { lookup } });
}

const causeCode = (error: unknown) => {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
};

async function request(inputUrl: string, options: HttpOptions = {}): Promise<HttpResponse> {
  const method = String(options.method || "GET").toUpperCase();
  let url = appendQuery(inputUrl, options.query);

  const headers = { ...options.headers };
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) {
    headers["User-Agent"] = APP_USER_AGENT;
  }
  const authHeader = basicAuthHeader(options.basicAuth);
  if (authHeader) headers.Authorization = authHeader;

  const controller = new AbortController();
  const externalSignal = options.signal;
  const handleExternalAbort = () => controller.abort(externalSignal!.reason);
  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else {
    externalSignal?.addEventListener("abort", handleExternalAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const startTimer = (ms: number) => {
    clearTimeout(timer);
    if (ms <= 0) return;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  startTimer(Number(options.timeoutMs || 0));

  const startedAt = Date.now();
  const publicDispatchers = [];
  const init: FetchInit = {
    method,
    headers,
    signal: controller.signal,
    dispatcher: resolveDispatcher(options),
  };

  const body = options.body;
  if (body != null && method !== "GET" && method !== "HEAD") {
    if (typeof body === "string" || body instanceof URLSearchParams || body instanceof Uint8Array) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
  }

  try {
    if (options.publicOnly) {
      init.dispatcher = await createPublicDispatcher(url);
      publicDispatchers.push(init.dispatcher);
    }
    let response!: FetchResponse;
    let requestMethod = method;
    for (let redirectCount = 0; ; redirectCount += 1) {
      const requestFetch = (usesNativeFetch() ? undiciFetch : globalThis.fetch) as NodeFetch;
      response = await requestFetch(url, { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
      if (redirectCount === MAX_REDIRECTS) {
        throw new HttpError(
          "Maximum number of redirects exceeded",
          { method, url },
          { code: "TOO_MANY_REDIRECTS" },
        );
      }
      const nextUrl = new URL(location, url).href;
      const crossesOrigin = new URL(url).origin !== new URL(nextUrl).origin;
      if (crossesOrigin) {
        removeHeaders(init.headers, SENSITIVE_REDIRECT_HEADERS);
        if (options.keepMethodOnRedirect && init.body != null) {
          throw new HttpError("Refusing to redirect request body across origins", { method, url });
        }
      }
      if (
        !options.keepMethodOnRedirect &&
        (([301, 302].includes(response.status) && requestMethod === "POST") ||
          (response.status === 303 && !["GET", "HEAD"].includes(requestMethod)))
      ) {
        requestMethod = "GET";
        init.method = requestMethod;
        delete init.body;
        removeHeaders(init.headers, BODY_HEADERS);
      }
      url = nextUrl;
      if (options.publicOnly) {
        init.dispatcher = await createPublicDispatcher(url);
        publicDispatchers.push(init.dispatcher);
      }
    }
    if (options.bodyTimeoutMs) startTimer(options.bodyTimeoutMs);
    const data = await readBody(response, options);
    controller.signal.throwIfAborted();
    const result = {
      status: response.status,
      statusText: response.statusText,
      headers: headersToObject(response.headers),
      data,
    };
    const ok = options.okStatus ?? ((status: number) => status >= 200 && status < 300);
    if (!ok(response.status)) {
      throw new HttpError(
        `Request to ${new URL(url).host} failed with status code ${response.status}`,
        { method, url },
        { response: result },
      );
    }
    return result;
  } catch (error) {
    const failure =
      error instanceof HttpError
        ? error
        : new HttpError(
            timedOut
              ? `Request to ${new URL(url).host} timed out`
              : error instanceof Error
                ? error.message
                : String(error),
            { method, url },
            {
              cause: error,
              code: timedOut ? "TIMEOUT" : controller.signal.aborted ? "ABORTED" : causeCode(error),
            },
          );
    if (timedOut || !externalSignal?.aborted) {
      const cause = failure.cause instanceof Error ? failure.cause.cause : undefined;
      try {
        reportFailure?.({
          method,
          url,
          status: failure.response?.status ?? null,
          code: failure.code ?? null,
          ms: Date.now() - startedAt,
          message:
            cause instanceof Error && cause.message
              ? `${failure.message}: ${cause.message}`
              : failure.message,
        });
      } catch {}
    }
    throw failure;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", handleExternalAbort);
    await Promise.allSettled(publicDispatchers.map((dispatcher) => dispatcher.close()));
  }
}

const withVerbs = (send: (url: string, options?: HttpOptions) => Promise<HttpResponse>) => ({
  request: send,
  get: (url: string, options: HttpOptions = {}) => send(url, { ...options, method: "GET" }),
  post: (url: string, body?: unknown, options: HttpOptions = {}) =>
    send(url, { ...options, method: "POST", body }),
  put: (url: string, body?: unknown, options: HttpOptions = {}) =>
    send(url, { ...options, method: "PUT", body }),
  delete: (url: string, options: HttpOptions = {}) => send(url, { ...options, method: "DELETE" }),
});

export const http = withVerbs(request);

export const createHttpClient = ({ baseUrl, ...defaults }: HttpOptions & { baseUrl: string }) =>
  withVerbs((url, options = {}) =>
    http.request(joinUrl(baseUrl, url), {
      ...defaults,
      ...options,
      headers: { ...defaults.headers, ...options.headers },
    }),
  );
