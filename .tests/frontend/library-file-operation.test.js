import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { startFrontendServer } from "../helpers/frontendServer.js";

const frontendRequire = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { createElement } = frontendRequire("react");
const { renderToStaticMarkup } = frontendRequire("react-dom/server");

async function renderOperation(t, operation) {
  const vite = await startFrontendServer();
  t.after(() => vite.close());
  const { default: LibraryFileOperation } = await vite.ssrLoadModule("/src/components/LibraryFileOperation.jsx");
  return renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(LibraryFileOperation, { operation }),
  ));
}

const finishedIngest = (overrides) => ({
  id: 1,
  kind: "ingest",
  status: "complete",
  options: { mode: "move" },
  summary: {},
  progress: { done: 6, total: 6, unit: "files" },
  ...overrides,
});

test("an ingest stored before Needs review was removed lists its held files as skipped", async (t) => {
  const markup = await renderOperation(t, finishedIngest({
    counts: { done: 2, duplicate: 1, conflict: 3 },
    sources: { removable: 0, removed: 0 },
  }));

  assert.doesNotMatch(markup, /review/i);
  assert.match(markup, /Finished\. Filed 2 files · Skipped 1 file already in the Library and 3 others\./);
  assert.match(markup, /aria-pressed="true"[^>]*>Skipped <span class="library-file-op__count">3</);
});

test("a finished Move ingest offers to remove only the source files it kept, and Copy offers nothing", async (t) => {
  const move = await renderOperation(t, finishedIngest({
    counts: { duplicate: 4 },
    sources: { removable: 3, removed: 0 },
  }));
  const copy = await renderOperation(t, finishedIngest({
    options: { mode: "copy" },
    counts: { duplicate: 4 },
    sources: null,
  }));

  assert.match(move, /Remove 3 source files already in the Library\?/);
  assert.match(move, />Remove source files</);
  assert.doesNotMatch(copy, /Remove/);
});
