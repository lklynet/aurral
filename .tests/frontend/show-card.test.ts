import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function renderShow(t, show) {
  vi.resetModules();
  const { default: ShowCard } = await import("../../frontend/src/components/ShowCard.tsx");
  return renderToStaticMarkup(createElement(ShowCard, { show }));
}

const elementsWithText = (markup, text) => markup.split(`>${text}<`).length - 1;

test("show cards skip the artist line when the event title already names the artist", async (t) => {
  const markup = await renderShow(t, {
    id: "tour",
    artistNames: ["Olivia Rodrigo"],
    eventName: "Olivia Rodrigo: The Unraveled Tour",
    date: "2026-11-15",
  });

  assert.equal(elementsWithText(markup, "Olivia Rodrigo"), 0);
  assert.ok(elementsWithText(markup, "Olivia Rodrigo: The Unraveled Tour") > 0);
});

test("show cards keep the artist line when the event title does not name the artist", async (t) => {
  const markup = await renderShow(t, {
    id: "festival",
    artistNames: ["Olivia Rodrigo"],
    eventName: "Summer Lights Festival",
    date: "2026-11-15",
  });

  assert.ok(elementsWithText(markup, "Olivia Rodrigo") > 0);
});
