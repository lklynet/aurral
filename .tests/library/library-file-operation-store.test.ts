import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { reopenToRemoveDuplicates }] = await setupIsolatedBackend(
  "library-file-operation-store",
  "backend/services/libraryFiles/operationStore.ts",
);
afterAll(() => cleanupIsolatedState(state));

test("asking to remove duplicates of an operation that does not exist reopens nothing", () => {
  assert.equal(reopenToRemoveDuplicates(999999, "Stopped early."), false);
});
