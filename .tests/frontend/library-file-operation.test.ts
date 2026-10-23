import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type FileOperation = Parameters<
  typeof import("../../frontend/src/components/LibraryFileOperation.tsx").default
>[0]["operation"];

async function renderOperation(operation: FileOperation) {
  vi.resetModules();
  const { default: LibraryFileOperation } =
    await import("../../frontend/src/components/LibraryFileOperation.tsx");
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(LibraryFileOperation, { operation }),
    ),
  );
}

const finishedIngest = (overrides: Partial<FileOperation>) =>
  ({
    id: 1,
    kind: "ingest" as const,
    status: "complete",
    options: { mode: "move" as const },
    summary: {},
    progress: { done: 6, total: 6 },
    updatedAt: 0,
    ...overrides,
  }) as FileOperation;

test("an ingest stored before Needs review was removed lists its held files as skipped", async () => {
  const markup = await renderOperation(
    finishedIngest({
      counts: { done: 2, duplicate: 1, conflict: 3 },
      sources: { removable: 0, removed: 0 },
    }),
  );

  assert.doesNotMatch(markup, /review/i);
  assert.match(
    markup,
    /Finished\. Filed 2 files · Skipped 1 file already in the Library and 3 others\./,
  );
  assert.match(markup, /aria-pressed="true"[^>]*>Skipped <span class="library-file-op__count">3</);
});

test("a finished Move ingest offers to remove only the source files it kept, and Copy offers nothing", async () => {
  const move = await renderOperation(
    finishedIngest({
      counts: { duplicate: 4 },
      sources: { removable: 3, removed: 0 },
    }),
  );
  const copy = await renderOperation(
    finishedIngest({
      options: { mode: "copy" },
      counts: { duplicate: 4 },
      sources: null,
    }),
  );

  assert.match(move, /Remove 3 source files already in the Library\?/);
  assert.match(move, />Remove source files</);
  assert.doesNotMatch(copy, /Remove/);
});

test("a finished clean up offers to remove the duplicate copies it found and lists them as duplicates", async () => {
  const markup = await renderOperation(
    finishedIngest({
      kind: "cleanup",
      options: {},
      counts: { done: 1, duplicate: 2 },
      sources: { removable: 2, removed: 0 },
    }),
  );

  assert.match(markup, /Remove 2 duplicate copies\?/);
  assert.match(markup, />Remove duplicates</);
  assert.match(
    markup,
    /aria-pressed="true"[^>]*>Duplicates <span class="library-file-op__count">2</,
  );
  assert.doesNotMatch(markup, /source file/);
});
