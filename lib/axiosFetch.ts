import type { Agent as HttpsAgent } from "node:https";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  Agent,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type Response as UndiciResponse,
} from "undici";
import { resolvePublicUrl } from "./publicUrl.ts";

type FetchResponse = UndiciResponse | Response;

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  dispatcher: Dispatcher;
  body?: string | URLSearchParams | Uint8Array;
}

type NodeFetch = (url: string, init: FetchInit & { redirect: "manual" }) => Promise<FetchResponse>;

interface AxiosBasicAuth {
  username?: string;
  password?: string;
}

interface AxiosRequestConfig {
  url?: string;
  method?: string;
  baseURL?: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  auth?: AxiosBasicAuth;
  data?: unknown;
  timeout?: number;
  maxRedirects?: 5;
  signal?: AbortSignal;
  responseType?: "arraybuffer" | "stream";
  validateStatus?: (status: number) => boolean;
  httpsAgent?: HttpsAgent;
  publicOnly?: boolean;
  preserveMethodOnRedirect?: boolean;
}

interface AxiosResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
}

interface AxiosError extends Error {
  code?: string;
  request?: { method: string; url: string };
  response?: AxiosResponse;
}

const usesNativeFetch = () =>
  Function.prototype.toString.call(globalThis.fetch).includes("internal/deps/undici");

function joinUrl(baseURL: string | undefined, url: string | undefined) {
  if (!url) return baseURL || "";
  if (String(url).startsWith("http://") || String(url).startsWith("https://")) return url;
  if (!baseURL) return url;
  return `${String(baseURL).replace(/\/+$/, "")}/${String(url).replace(/^\/+/, "")}`;
}

function appendParams(url: string, params: AxiosRequestConfig["params"]) {
  if (!params || typeof params !== "object") return url;
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function headersToObject(
  headers: FetchResponse["headers"] | AxiosRequestConfig["headers"],
): Record<string, string> {
  const output: Record<string, string> = {};
  if (!headers) return output;
  if (typeof headers.forEach === "function") {
    headers.forEach((value: string, key: string) => {
      output[key] = value;
    });
    return output;
  }
  return { ...(headers as Record<string, string>) };
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

function resolveDispatcher(config: AxiosRequestConfig) {
  if (config.httpsAgent?.options?.rejectUnauthorized === false) {
    return insecureDispatcher;
  }
  if (process.env.NODE_USE_ENV_PROXY === "1") {
    envProxyDispatcher ||= new EnvHttpProxyAgent();
    return envProxyDispatcher;
  }
  return defaultDispatcher;
}

async function readBody(response: FetchResponse, config: AxiosRequestConfig) {
  if (config.responseType === "stream") {
    if (response.body) return Readable.fromWeb(response.body as NodeReadableStream);
    return Readable.from([]);
  }
  if (config.responseType === "arraybuffer") {
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

function buildAuthHeader(auth: AxiosBasicAuth | undefined) {
  if (!auth?.username && !auth?.password) return null;
  const encoded = Buffer.from(`${auth.username || ""}:${auth.password || ""}`).toString("base64");
  return `Basic ${encoded}`;
}

const MAX_REDIRECTS = 5;
const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-gotify-key",
  "x-plex-token",
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

async function axiosRequest(inputConfig: AxiosRequestConfig) {
  const config = { ...inputConfig };
  const method = String(config.method || "GET").toUpperCase();
  let url = config.url || "";
  if (config.baseURL) url = joinUrl(config.baseURL, url);
  url = appendParams(url, config.params);

  const headers = headersToObject(config.headers);
  const authHeader = buildAuthHeader(config.auth);
  if (authHeader) headers.Authorization = authHeader;

  const controller = new AbortController();
  const externalSignal = config.signal;
  const handleExternalAbort = () => controller.abort(externalSignal!.reason);
  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else {
    externalSignal?.addEventListener("abort", handleExternalAbort, { once: true });
  }
  const timeoutMs = Number(config.timeout || 0);
  let timer = null;
  let timeoutTriggered = false;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort();
    }, timeoutMs);
  }

  const publicDispatchers = [];
  const init: FetchInit = {
    method,
    headers,
    signal: controller.signal,
    dispatcher: resolveDispatcher(config),
  };

  const body = config.data;
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
    if (config.publicOnly) {
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
        const error: AxiosError = new Error("Maximum number of redirects exceeded");
        error.code = "ERR_FR_TOO_MANY_REDIRECTS";
        throw error;
      }
      const nextUrl = new URL(location, url).href;
      const crossesOrigin = new URL(url).origin !== new URL(nextUrl).origin;
      if (crossesOrigin) {
        removeHeaders(init.headers, SENSITIVE_REDIRECT_HEADERS);
        if (config.preserveMethodOnRedirect && init.body != null) {
          throw new Error("Refusing to redirect request body across origins");
        }
      }
      if (
        !config.preserveMethodOnRedirect &&
        (([301, 302].includes(response.status) && requestMethod === "POST") ||
          (response.status === 303 && !["GET", "HEAD"].includes(requestMethod)))
      ) {
        requestMethod = "GET";
        init.method = requestMethod;
        delete init.body;
        removeHeaders(init.headers, BODY_HEADERS);
      }
      url = nextUrl;
      if (config.publicOnly) {
        init.dispatcher = await createPublicDispatcher(url);
        publicDispatchers.push(init.dispatcher);
      }
    }
    const data = await readBody(response, config);
    controller.signal.throwIfAborted();
    const axiosResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: headersToObject(response.headers),
      data,
    };
    const validateStatus =
      typeof config.validateStatus === "function"
        ? config.validateStatus
        : (status: number) => status >= 200 && status < 300;
    if (!validateStatus(response.status)) {
      const error: AxiosError = new Error(
        `Request to ${new URL(url).host} failed with status code ${response.status}`,
      );
      error.response = axiosResponse;
      error.code = controller.signal.aborted ? "ECONNABORTED" : undefined;
      throw error;
    }
    return axiosResponse;
  } catch (error) {
    const failure: AxiosError | undefined = error instanceof Error ? error : undefined;
    if (timeoutTriggered) {
      Object.defineProperty(error, "code", {
        configurable: true,
        enumerable: true,
        value: "ECONNABORTED",
        writable: true,
      });
    } else if (failure && controller.signal.aborted && !failure.code) {
      failure.code = "ECONNABORTED";
    }
    if (failure && !failure.response && !failure.request) {
      failure.request = { method, url };
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", handleExternalAbort);
    await Promise.allSettled(publicDispatchers.map((dispatcher) => dispatcher.close()));
  }
}

function create(defaults: AxiosRequestConfig = {}) {
  const withDefaults = (config: AxiosRequestConfig = {}) =>
    axiosRequest({ ...defaults, ...config });
  withDefaults.request = withDefaults;
  withDefaults.get = (url: string, config: AxiosRequestConfig = {}) =>
    withDefaults({ ...config, method: "GET", url });
  withDefaults.post = (url: string, data: unknown, config: AxiosRequestConfig = {}) =>
    withDefaults({ ...config, method: "POST", url, data });
  withDefaults.put = (url: string, data: unknown, config: AxiosRequestConfig = {}) =>
    withDefaults({ ...config, method: "PUT", url, data });
  withDefaults.delete = (url: string, config: AxiosRequestConfig = {}) =>
    withDefaults({ ...config, method: "DELETE", url });
  return withDefaults;
}

function axios(config: AxiosRequestConfig) {
  return axiosRequest(config);
}

axios.request = axiosRequest;
axios.get = (url: string, config: AxiosRequestConfig = {}) =>
  axiosRequest({ ...config, method: "GET", url });
axios.post = (url: string, data: unknown, config: AxiosRequestConfig = {}) =>
  axiosRequest({ ...config, method: "POST", url, data });
axios.put = (url: string, data: unknown, config: AxiosRequestConfig = {}) =>
  axiosRequest({ ...config, method: "PUT", url, data });
axios.delete = (url: string, config: AxiosRequestConfig = {}) =>
  axiosRequest({ ...config, method: "DELETE", url });
axios.create = create;

export { defaultDispatcher };

export default axios;
