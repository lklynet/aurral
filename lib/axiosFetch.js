import { Readable } from "node:stream";
import { Agent, fetch as undiciFetch } from "undici";
import { resolvePublicUrl } from "./publicUrl.js";

const usesNativeFetch = () => Function.prototype.toString.call(globalThis.fetch).includes("internal/deps/undici");

function joinUrl(baseURL, url) {
  if (!url) return baseURL || "";
  if (String(url).startsWith("http://") || String(url).startsWith("https://")) return url;
  if (!baseURL) return url;
  return `${String(baseURL).replace(/\/+$/, "")}/${String(url).replace(/^\/+/, "")}`;
}

function appendParams(url, params) {
  if (!params || typeof params !== "object") return url;
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function headersToObject(headers) {
  const output = {};
  if (!headers) return output;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      output[key] = value;
    });
    return output;
  }
  return { ...headers };
}

const defaultDispatcher = new Agent({
  connections: 16,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

const insecureDispatcher = new Agent({
  connections: 16,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: { rejectUnauthorized: false },
});

function resolveDispatcher(config) {
  if (config.httpsAgent?.options?.rejectUnauthorized === false) {
    return insecureDispatcher;
  }
  return defaultDispatcher;
}

async function readBody(response, config) {
  if (config.responseType === "stream") {
    if (response.body) return Readable.fromWeb(response.body);
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

function buildAuthHeader(auth) {
  if (!auth?.username && !auth?.password) return null;
  const encoded = Buffer.from(`${auth.username || ""}:${auth.password || ""}`).toString("base64");
  return `Basic ${encoded}`;
}

const SENSITIVE_REDIRECT_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);
const BODY_HEADERS = new Set(["content-length", "content-type", "transfer-encoding"]);

function removeHeaders(headers, names) {
  for (const name of Object.keys(headers)) {
    if (names.has(name.toLowerCase())) delete headers[name];
  }
}

async function createPublicDispatcher(url) {
  const { addresses } = await resolvePublicUrl(url);
  const lookup = (_hostname, options, callback) => {
    queueMicrotask(() => {
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
  return new Agent({ connections: 1, connect: { lookup } });
}

async function axiosRequest(inputConfig) {
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
  const handleExternalAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else {
    externalSignal?.addEventListener("abort", handleExternalAbort, { once: true });
  }
  const timeoutMs = Number(config.timeout || 0);
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  const publicDispatchers = [];
  const init = {
    method,
    headers,
    signal: controller.signal,
    dispatcher: resolveDispatcher(config),
  };

  const body = config.data;
  if (body != null && method !== "GET" && method !== "HEAD") {
    if (typeof body === "string" || body instanceof URLSearchParams) {
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
    let response;
    let requestMethod = method;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const requestFetch = usesNativeFetch() ? undiciFetch : globalThis.fetch;
      response = await requestFetch(url, { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
      const nextUrl = new URL(location, url).href;
      if (new URL(url).origin !== new URL(nextUrl).origin) {
        removeHeaders(init.headers, SENSITIVE_REDIRECT_HEADERS);
      }
      if (([301, 302].includes(response.status) && requestMethod === "POST")
        || (response.status === 303 && !["GET", "HEAD"].includes(requestMethod))) {
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
    const axiosResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: headersToObject(response.headers),
      data,
    };
    const validateStatus =
      typeof config.validateStatus === "function"
        ? config.validateStatus
        : (status) => status >= 200 && status < 300;
    if (!validateStatus(response.status)) {
      const error = new Error(`Request failed with status code ${response.status}`);
      error.response = axiosResponse;
      error.code = controller.signal.aborted ? "ECONNABORTED" : undefined;
      throw error;
    }
    return axiosResponse;
  } catch (error) {
    if (controller.signal.aborted && !error.code) {
      error.code = "ECONNABORTED";
    }
    if (!error.response && !error.request) {
      error.request = { method, url };
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", handleExternalAbort);
    await Promise.allSettled(publicDispatchers.map((dispatcher) => dispatcher.close()));
  }
}

function create(defaults = {}) {
  const withDefaults = (config = {}) => axiosRequest({ ...defaults, ...config });
  withDefaults.request = withDefaults;
  withDefaults.get = (url, config = {}) => withDefaults({ ...config, method: "GET", url });
  withDefaults.post = (url, data, config = {}) =>
    withDefaults({ ...config, method: "POST", url, data });
  withDefaults.put = (url, data, config = {}) =>
    withDefaults({ ...config, method: "PUT", url, data });
  withDefaults.delete = (url, config = {}) => withDefaults({ ...config, method: "DELETE", url });
  return withDefaults;
}

function axios(config) {
  return axiosRequest(config);
}

axios.request = axiosRequest;
axios.get = (url, config = {}) => axiosRequest({ ...config, method: "GET", url });
axios.post = (url, data, config = {}) => axiosRequest({ ...config, method: "POST", url, data });
axios.put = (url, data, config = {}) => axiosRequest({ ...config, method: "PUT", url, data });
axios.delete = (url, config = {}) => axiosRequest({ ...config, method: "DELETE", url });
axios.create = create;

export { defaultDispatcher };

export default axios;
