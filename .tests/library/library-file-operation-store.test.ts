import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [
  state,
  {
    createLibraryFileOperation,
    dismissLibraryFileOperation,
    getLatestLibraryFileOperation,
    reopenToRemoveDuplicates,
    transitionLibraryFileOperation,
  },
] = await setupIsolatedBackend(
  "library-file-operation-store",
  () => import("../../backend/services/libraryFiles/operationStore.ts"),
);
afterAll(() => cleanupIsolatedState(state));

test("asking to remove duplicates of an operation that does not exist reopens nothing", () => {
  assert.equal(reopenToRemoveDuplicates(999999, "Stopped early."), false);
});

test("a finished operation can be cleared, and a running one cannot", () => {
  const operation = createLibraryFileOperation({ kind: "cleanup" });
  assert.ok(operation != null);
  dismissLibraryFileOperation(operation.id);
  assert.equal(getLatestLibraryFileOperation()?.id, operation.id);

  transitionLibraryFileOperation(operation.id, ["planning"], "complete");
  dismissLibraryFileOperation(operation.id);
  assert.equal(getLatestLibraryFileOperation(), undefined);

  const next = createLibraryFileOperation({ kind: "cleanup" });
  assert.equal(getLatestLibraryFileOperation()?.id, next?.id);
});
