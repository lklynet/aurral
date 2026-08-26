import { getAppBasePath } from "../basePath.js";

const getDefaultApiBaseUrl = () => {
  if (import.meta.env.DEV) return "/api";
  const basePath = getAppBasePath();
  if (basePath === "/") return "/api";
  return `${basePath}/api`;
};

const API_BASE_URL = import.meta.env.VITE_API_URL || getDefaultApiBaseUrl();

function joinUrl(baseURL, url) {
  if (!url) return baseURL;
  if (String(url).startsWith("http://") || String(url).startsWith("https://")) return url;
  return `${String(baseURL).replace(/\/+$/, "")}/${String(url).replace(/^\/+/, "")}`;
}

function appendParams(url, params) {
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

async function request(config) {
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
  const timeoutMs = Number(config.timeout ?? 30000);
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const isBinaryData = config.data instanceof Blob || config.data instanceof FormData;
  const headers = { ...(isBinaryData ? {} : { "Content-Type": "application/json" }), ...config.headers };
  const token = getRequestToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const urlPath = String(config.url || "");
  const isAuthEndpoint = /\/auth(?:\/|$)/.test(urlPath);

  try {
    const init = {
      method,
      headers,
      signal: controller.signal,
      redirect: "manual",
      credentials: config.credentials || "include",
    };
    if (config.data != null && method !== "GET" && method !== "HEAD") {
      if (typeof config.data === "string" || isBinaryData) {
        init.body = config.data;
      } else {
        init.body = JSON.stringify(config.data);
      }
    }
    const res = await fetch(url, init);

    if (res.type === "opaqueredirect") {
      if (!isAuthEndpoint) reauthenticateThroughProxy();
      throw new Error("Request was redirected to an authentication provider");
    }

    const contentType = res.headers.get("content-type") || "";
    let data;
    if (contentType.includes("json")) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    } else {
      data = await res.text();
    }
    const response = { status: res.status, statusText: res.statusText, headers: res.headers, data };
    if (!res.ok) {
      const error = new Error(`Request failed with status code ${res.status}`);
      error.response = response;
      if (res.status === 401 && !isAuthEndpoint) {
        const isAurralAuthError =
          data?.error === "Unauthorized" ||
          data?.code === "AUTH_REQUIRED" ||
          data?.code === "SESSION_INVALID";
        if (isAurralAuthError) {
          clearAuthStorage();
        } else if (data?.error && typeof data.error === "object") {
          reauthenticateThroughProxy();
        } else if (!data?.error) {
          reauthenticateThroughProxy();
        }
      }
      throw error;
    }
    return response;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

const api = {
  get: (url, config = {}) => request({ ...config, method: "GET", url }),
  post: (url, data, config = {}) => request({ ...config, method: "POST", url, data }),
  put: (url, data, config = {}) => request({ ...config, method: "PUT", url, data }),
  patch: (url, data, config = {}) => request({ ...config, method: "PATCH", url, data }),
  delete: (url, config = {}) => request({ ...config, method: "DELETE", url }),
};

const AUTH_TOKEN_KEY = "bearer_token";
const LEGACY_AUTH_TOKEN_KEY = "auth_token";

function readAuthFromStorage(storage) {
  if (!storage) return { token: "" };
  const token = storage.getItem(AUTH_TOKEN_KEY);
  if (token) return { token };
  const legacyToken = storage.getItem(LEGACY_AUTH_TOKEN_KEY);
  if (legacyToken) {
    storage.setItem(AUTH_TOKEN_KEY, legacyToken);
    return { token: legacyToken };
  }
  return { token: "" };
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

export const setStoredAuth = ({ token = "" } = {}) => {
  globalThis?.sessionStorage?.removeItem(LEGACY_AUTH_TOKEN_KEY);
  globalThis?.localStorage?.removeItem(LEGACY_AUTH_TOKEN_KEY);
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
  globalThis?.sessionStorage?.removeItem(LEGACY_AUTH_TOKEN_KEY);
  globalThis?.localStorage?.removeItem(LEGACY_AUTH_TOKEN_KEY);
};

export const coverResponseCache = new Map();
export const coverInflightRequests = new Map();
const MAX_COVER_CACHE_SIZE = 1000;
const COVER_CACHE_TTL_MS = 30 * 60 * 1000;
const EMPTY_COVER_CACHE_TTL_MS = 60 * 1000;
export const setCoverCacheEntry = (key, value) => {
  if (!key) return;
  const images = Array.isArray(value?.images) ? value.images : [];
  const hasArtwork = images.length > 0 || Boolean(value?.image || value?.imageUrl || value?.coverUrl);
  const ttlMs = hasArtwork ? COVER_CACHE_TTL_MS : EMPTY_COVER_CACHE_TTL_MS;
  if (coverResponseCache.has(key)) coverResponseCache.delete(key);
  coverResponseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (coverResponseCache.size > MAX_COVER_CACHE_SIZE) {
    const oldestKey = coverResponseCache.keys().next().value;
    if (oldestKey !== undefined) coverResponseCache.delete(oldestKey);
  }
};

export const getCoverCacheEntry = (key) => {
  const entry = coverResponseCache.get(key);
  if (!entry) return null;
  if (Date.now() >= Number(entry.expiresAt || 0)) {
    coverResponseCache.delete(key);
    return null;
  }
  return entry.value;
};

export const fetchInflightOnce = async (store, key, requestFactory) => {
  if (store.has(key)) return store.get(key);
  const request = requestFactory().finally(() => store.delete(key));
  store.set(key, request);
  return request;
};

export const fetchCoverWithMemo = async (key, requestFactory, { bypassCache = false } = {}) => {
  if (!bypassCache) {
    const cached = getCoverCacheEntry(key);
    if (cached) return cached;
  }
  return fetchInflightOnce(coverInflightRequests, key, () =>
    requestFactory().then((response) => {
      setCoverCacheEntry(key, response);
      return response;
    }),
  );
};

const responseData = (req) => req.then((response) => response.data);
export const getData = (url, config) => responseData(api.get(url, config));
export const postData = (url, data, config) => responseData(api.post(url, data, config));
export const putData = (url, data, config) => responseData(api.put(url, data, config));
export const patchData = (url, data, config) => responseData(api.patch(url, data, config));
export const deleteData = (url, config) => responseData(api.delete(url, config));

export const lidarrCredentialParams = (url, apiKey, { trimUrl = false } = {}) => ({
  ...(url ? { url: trimUrl ? url.replace(/\/+$/, "") : url } : {}),
  ...(apiKey ? { apiKey } : {}),
});

const getApiBaseUrl = () => import.meta.env.VITE_API_URL || getDefaultApiBaseUrl();

export const buildAuthenticatedApiUrl = (path, params = {}) => {
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

export default api;
