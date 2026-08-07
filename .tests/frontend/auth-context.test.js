import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createServer } from "vite";

const createAuthProviderHarness = (AuthProvider) => {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  let hookIndex = 0;
  const states = [];
  const refs = [];
  const dispatcher = {
    useState: (initial) => {
      const index = hookIndex++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => {
        states[index] = typeof value === "function" ? value(states[index]) : value;
      }];
    },
    useRef: (initial) => {
      const index = hookIndex++;
      refs[index] ||= { current: initial };
      return refs[index];
    },
    useCallback: (callback) => {
      hookIndex += 1;
      return callback;
    },
    useEffect: () => {
      hookIndex += 1;
    },
    useMemo: (factory) => {
      hookIndex += 1;
      return factory();
    },
  };

  return () => {
    hookIndex = 0;
    const previousDispatcher = internals.H;
    internals.H = dispatcher;
    try {
      return AuthProvider({ children: null }).props.value;
    } finally {
      internals.H = previousDispatcher;
    }
  };
};

test("a resolved auth session survives a temporary bootstrap failure", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });

  t.after(() => vite.close());

  const { AuthProvider, shouldResetAuthAfterBootstrapFailure } = await vite.ssrLoadModule(
    "/src/contexts/AuthContext.jsx?auth-failure-test",
  );
  assert.equal(shouldResetAuthAfterBootstrapFailure(true), false);
  assert.equal(shouldResetAuthAfterBootstrapFailure(false), true);

  const { invalidateBootstrapCache } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/auth.js?auth-failure-test",
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const user = { id: 7, username: "blu" };
  globalThis.fetch = async () => new Response(JSON.stringify({ authRequired: true, user }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  invalidateBootstrapCache();
  const renderAuthProvider = createAuthProviderHarness(AuthProvider);
  let auth = renderAuthProvider();
  await auth.refreshAuth();
  auth = renderAuthProvider();
  assert.equal(auth.isAuthenticated, true);
  assert.deepEqual(auth.user, user);
  const authenticatedUser = auth.user;

  globalThis.fetch = async () => {
    throw new Error("temporary bootstrap failure");
  };
  invalidateBootstrapCache();
  await auth.refreshAuth();
  auth = renderAuthProvider();
  assert.equal(auth.isAuthenticated, true);
  assert.equal(auth.user, authenticatedUser);
});
