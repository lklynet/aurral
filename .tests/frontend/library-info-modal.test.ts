import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("track info shows the bit depth the library scanner stores", async () => {
  vi.resetModules();
  vi.doMock("../../frontend/src/contexts/AuthContext.tsx", () => ({
    useAuth: () => ({ user: { role: "user", permissions: {} } }),
  }));
  const { default: LibraryInfoModal } =
    await import("../../frontend/src/pages/LibraryInfoModal.tsx");
  const markup = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(LibraryInfoModal, {
        onClose: () => {},
        item: {
          kind: "track",
          entity: {
            id: 7,
            title: "Opening Scene",
            files: [
              {
                available: true,
                format: "flac",
                quality: { bitrate: 1411, bitsPerSample: 24 },
              },
            ],
          },
        },
      }),
    ),
  );

  assert.match(markup, /1411 kbps · 24 bit/);
});
