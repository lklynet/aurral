import { getAppBasePath } from "../basePath.ts";
import type { LibraryAvailability } from "../libraryDestination.ts";

const getDefaultApiBaseUrl = () => {
  if (import.meta.env.DEV) return "/api";
  const basePath = getAppBasePath();
  if (basePath === "/") return "/api";
  return `${basePath}/api`;
};

export const API_BASE_URL = import.meta.env.VITE_API_URL || getDefaultApiBaseUrl();
const REQUEST_TIMEOUT_MS = 30000;

export interface ApiErrorBody {
  message?: string;
  error?: string | Record<string, unknown>;
  code?: string;
  managedBy?: string | null;
  availability?: LibraryAvailability | null;
  conflict?: { managedBy?: string | null; availability?: LibraryAvailability | null } | null;
}

export interface ApiErrorResponse {
  status: number;
  statusText: string;
  headers: Headers;
  data: ApiErrorBody | string | null;
}

export type ApiError = Error & { response?: ApiErrorResponse };

export function asApiError(error: unknown): ApiError | undefined {
  return error instanceof Error ? error : undefined;
}

interface RequestConfig {
  method?: string;
  url?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;
  keepalive?: boolean;
}

function joinUrl(baseURL: string, url: string) {
  if (!url) return baseURL;
  if (String(url).startsWith("http://") || String(url).startsWith("https://")) return url;
  return `${String(baseURL).replace(/\/+$/, "")}/${String(url).replace(/^\/+/, "")}`;
}

function appendParams(url: string, params: Record<string, unknown> | undefined) {
  if (!params || typeof params !== "object") return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  if (!query) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

const REAUTH_COOLDOWN_MS = 30000;
const REAUTH_AT_KEY = "aurral:reauth-at";
let reauthStarted = false;

const dropServiceWorker = async () => {
  const registrations = (await globalThis?.navigator?.serviceWorker?.getRegistrations?.()) || [];
  const cacheKeys = (await globalThis?.caches?.keys?.()) || [];
  await Promise.allSettled(registrations.map((registration) => registration.unregister()));
  await Promise.allSettled(cacheKeys.map((cacheKey) => globalThis.caches.delete(cacheKey)));
};

const reauthenticateThroughProxy = () => {
  if (reauthStarted || typeof window === "undefined") return;
  const lastAt = Number(globalThis?.sessionStorage?.getItem(REAUTH_AT_KEY) || 0);
  if (Date.now() - lastAt < REAUTH_COOLDOWN_MS) return;
  reauthStarted = true;
  globalThis?.sessionStorage?.setItem(REAUTH_AT_KEY, String(Date.now()));
  clearAuthStorage();
  void dropServiceWorker().then(() => window.location.reload());
};

async function readBody(res: Response): Promise<unknown> {
  if (!(res.headers.get("content-type") || "").includes("json")) return res.text();
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureOk(res: Response, url: string) {
  const isAuthEndpoint = url.includes("/auth/login") || url.includes("/auth/logout");
  if (res.type === "opaqueredirect") {
    if (!isAuthEndpoint) reauthenticateThroughProxy();
    throw new Error("Request was redirected to an authentication provider");
  }
  if (res.ok) return res;

  const data = await readBody(res);
  const error: ApiError = new Error(`Request failed with status code ${res.status}`);
  const errorData: ApiErrorResponse["data"] =
    typeof data === "string" || typeof data === "object" ? data : null;
  error.response = {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    data: errorData,
  };
  if (res.status === 401 && !isAuthEndpoint) {
    const body = typeof errorData === "object" && errorData ? errorData : undefined;
    const isAurralAuthError =
      body?.error === "Unauthorized" ||
      body?.code === "AUTH_REQUIRED" ||
      body?.code === "SESSION_INVALID";
    if (isAurralAuthError) {
      clearAuthStorage();
    } else if (body?.error && typeof body.error === "object") {
      reauthenticateThroughProxy();
    } else if (!body?.error) {
      reauthenticateThroughProxy();
    }
  }
  throw error;
}

async function request(config: RequestConfig) {
  const method = String(config.method || "GET").toUpperCase();
  let url = appendParams(joinUrl(API_BASE_URL, config.url || ""), config.params);
  const controller = new AbortController();
  const callerSignal = config.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeoutMs = Number(config.timeout ?? REQUEST_TIMEOUT_MS);
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const isBinaryData = config.data instanceof Blob || config.data instanceof FormData;
  const headers: Record<string, string> = {
    ...(isBinaryData ? {} : { "Content-Type": "application/json" }),
    ...config.headers,
  };
  const token = getRequestToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const init: RequestInit = { method, headers, signal: controller.signal, redirect: "manual" };
    if (config.data != null && method !== "GET" && method !== "HEAD") {
      if (typeof config.data === "string" || isBinaryData) {
        init.body = config.data as BodyInit;
      } else {
        init.body = JSON.stringify(config.data);
      }
    }
    if (config.keepalive && (typeof init.body !== "string" || init.body.length < 60_000)) {
      init.keepalive = true;
    }
    const res = await ensureOk(await fetch(url, init), String(config.url || ""));
    const data = await readBody(res);
    return { status: res.status, statusText: res.statusText, headers: res.headers, data };
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export const apiFetchWithin =
  (timeoutMs: number) =>
  async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const token = getRequestToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(input, {
      ...init,
      headers,
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      redirect: "manual",
    });
    return ensureOk(res, input instanceof Request ? input.url : String(input));
  };

export const apiFetch = apiFetchWithin(REQUEST_TIMEOUT_MS);

const api = {
  get: (url: string, config: RequestConfig = {}) => request({ ...config, method: "GET", url }),
  post: (url: string, data?: unknown, config: RequestConfig = {}) =>
    request({ ...config, method: "POST", url, data }),
  put: (url: string, data?: unknown, config: RequestConfig = {}) =>
    request({ ...config, method: "PUT", url, data }),
  patch: (url: string, data?: unknown, config: RequestConfig = {}) =>
    request({ ...config, method: "PATCH", url, data }),
  delete: (url: string, config: RequestConfig = {}) =>
    request({ ...config, method: "DELETE", url }),
};

const AUTH_TOKEN_KEY = "auth_token";

function readAuthFromStorage(storage: Storage | null | undefined) {
  if (!storage) return { token: "" };
  return { token: storage.getItem(AUTH_TOKEN_KEY) || "" };
}

export const getStoredAuth = () => {
  const localAuth = readAuthFromStorage(globalThis?.localStorage);
  if (localAuth.token) return localAuth;
  const sessionAuth = readAuthFromStorage(globalThis?.sessionStorage);
  if (sessionAuth.token && globalThis?.localStorage) {
    globalThis.localStorage.setItem(AUTH_TOKEN_KEY, sessionAuth.token);
    return sessionAuth;
  }
  return sessionAuth;
};

export const getRequestToken = () => getStoredAuth().token;

export const setStoredAuth = ({ token = "" }: { token?: string } = {}) => {
  if (!token) {
    globalThis?.sessionStorage?.removeItem(AUTH_TOKEN_KEY);
    globalThis?.localStorage?.removeItem(AUTH_TOKEN_KEY);
    return;
  }
  globalThis?.sessionStorage?.setItem(AUTH_TOKEN_KEY, token);
  globalThis?.localStorage?.setItem(AUTH_TOKEN_KEY, token);
};

export const clearAuthStorage = () => {
  globalThis?.sessionStorage?.removeItem(AUTH_TOKEN_KEY);
  globalThis?.localStorage?.removeItem(AUTH_TOKEN_KEY);
};

export interface CoverCacheValue {
  images?: unknown[];
  image?: unknown;
  imageUrl?: unknown;
  coverUrl?: unknown;
}

export const coverResponseCache = new Map<string, { value: CoverCacheValue; expiresAt: number }>();
export const coverInflightRequests = new Map<string, Promise<unknown>>();
const MAX_COVER_CACHE_SIZE = 1000;
const COVER_CACHE_TTL_MS = 30 * 60 * 1000;
const EMPTY_COVER_CACHE_TTL_MS = 60 * 1000;
export const setCoverCacheEntry = (key: string, value: CoverCacheValue) => {
  if (!key) return;
  const images = Array.isArray(value?.images) ? value.images : [];
  const hasArtwork =
    images.length > 0 || Boolean(value?.image || value?.imageUrl || value?.coverUrl);
  const ttlMs = hasArtwork ? COVER_CACHE_TTL_MS : EMPTY_COVER_CACHE_TTL_MS;
  if (coverResponseCache.has(key)) coverResponseCache.delete(key);
  coverResponseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (coverResponseCache.size > MAX_COVER_CACHE_SIZE) {
    const oldestKey = coverResponseCache.keys().next().value;
    if (oldestKey !== undefined) coverResponseCache.delete(oldestKey);
  }
};

export const getCoverCacheEntry = <T extends CoverCacheValue>(key: string): T | null => {
  const entry = coverResponseCache.get(key);
  if (!entry) return null;
  if (Date.now() >= Number(entry.expiresAt || 0)) {
    coverResponseCache.delete(key);
    return null;
  }
  return entry.value as T;
};

export const fetchInflightOnce = async <T>(
  store: Map<string, Promise<unknown>>,
  key: string,
  requestFactory: () => Promise<T>,
): Promise<T> => {
  if (store.has(key)) return store.get(key) as Promise<T>;
  const request = requestFactory().finally(() => store.delete(key));
  store.set(key, request);
  return request;
};

export const fetchCoverWithMemo = async <T extends CoverCacheValue>(
  key: string,
  requestFactory: () => Promise<T>,
  { bypassCache = false }: { bypassCache?: boolean } = {},
): Promise<T> => {
  const refreshKey = `${key}:refresh`;
  if (!bypassCache) {
    const refresh = coverInflightRequests.get(refreshKey);
    if (refresh) return refresh as Promise<T>;
    const cached = getCoverCacheEntry<T>(key);
    if (cached) return cached;
  } else {
    const normal = coverInflightRequests.get(key);
    if (normal) await normal.catch(() => undefined);
  }

  return fetchInflightOnce(coverInflightRequests, bypassCache ? refreshKey : key, () =>
    requestFactory().then((response) => {
      setCoverCacheEntry(key, response);
      return response;
    }),
  );
};

const responseData = <T>(req: Promise<{ data: unknown }>): Promise<T> =>
  req.then((response) => response.data as T);
export const getData = <T>(url: string, config?: RequestConfig): Promise<T> =>
  responseData<T>(api.get(url, config));
export const postData = <T>(url: string, data?: unknown, config?: RequestConfig): Promise<T> =>
  responseData<T>(api.post(url, data, config));
export const putData = <T>(url: string, data?: unknown, config?: RequestConfig): Promise<T> =>
  responseData<T>(api.put(url, data, config));
export const patchData = <T>(url: string, data?: unknown, config?: RequestConfig): Promise<T> =>
  responseData<T>(api.patch(url, data, config));
export const deleteData = <T>(url: string, config?: RequestConfig): Promise<T> =>
  responseData<T>(api.delete(url, config));

export const lidarrCredentialParams = (
  url: string | undefined,
  apiKey: string | undefined,
  { trimUrl = false }: { trimUrl?: boolean } = {},
) => ({
  ...(url ? { url: trimUrl ? url.replace(/\/+$/, "") : url } : {}),
  ...(apiKey ? { apiKey } : {}),
});

const getApiBaseUrl = () => import.meta.env.VITE_API_URL || getDefaultApiBaseUrl();

export const resolveApiPath = (path: string) =>
  joinUrl(getApiBaseUrl(), String(path || "").replace(/^\/api(?=\/)/, ""));

export const buildAuthenticatedApiUrl = (path: string, params: Record<string, unknown> = {}) => {
  const normalizedPath = String(path || "").startsWith("/")
    ? String(path || "")
    : `/${String(path || "")}`;
  const query = new URLSearchParams();
  const token = getRequestToken();
  if (token) query.set("token", token);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") query.set(key, String(value));
  });
  const queryString = query.toString();
  return `${getApiBaseUrl()}${normalizedPath}${
    queryString ? `${normalizedPath.includes("?") ? "&" : "?"}${queryString}` : ""
  }`;
};

export const resolveAuthenticatedApiAssetUrl = (value: string | null | undefined) => {
  const url = String(value || "");
  return url.startsWith("/api/") ? buildAuthenticatedApiUrl(url.replace(/^\/api/, "")) : url;
};

export default api;
