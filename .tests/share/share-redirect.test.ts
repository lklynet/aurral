import assert from "node:assert/strict";
import { afterEach, test, vi } from "vite-plus/test";
import { consumeShareImport, rememberShareImport } from "../../frontend/src/utils/shareLink.ts";

afterEach(() => vi.unstubAllGlobals());

for (const action of ["open", "details", "files"]) {
  test(`sign-in keeps the selected ${action} action and app base path`, () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    });
    const url = "https://aurral.org/s/s123456789abcdef";
    const search = new URLSearchParams({ url, action });
    vi.stubGlobal("window", {
      location: { pathname: "/music/share/import", search: `?${search}` },
    });
    rememberShareImport();
    assert.equal(consumeShareImport(), `/share/import?${search}`);
  });
}

test("SSO resumes the requested share import under an app base path", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    setItem: (key: string, value: string) => values.set(key, value),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
  });
  const share = "https://aurral.org/s/example.share";
  vi.stubGlobal("window", {
    location: { pathname: "/music/share/import", search: `?url=${encodeURIComponent(share)}` },
  });
  rememberShareImport();
  assert.equal(consumeShareImport(), `/share/import?url=${encodeURIComponent(share)}`);
  assert.equal(consumeShareImport(), null);
});

test("signing in elsewhere clears an abandoned import instead of redirecting to it", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    setItem: (key: string, value: string) => values.set(key, value),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("window", {
    location: { pathname: "/share/import", search: "?url=https://aurral.org/s/example.share" },
  });
  rememberShareImport();
  vi.stubGlobal("window", { location: { pathname: "/settings", search: "" } });
  rememberShareImport();
  assert.equal(consumeShareImport(), null);
});
