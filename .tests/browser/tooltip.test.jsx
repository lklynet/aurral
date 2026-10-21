import { afterEach, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";
import { createRoot } from "react-dom/client";
import "../../frontend/src/index.css";
import Tooltip from "../../frontend/src/components/Tooltip.jsx";
import TooltipButton from "../../frontend/src/components/TooltipButton.jsx";

let root;

function render(ui) {
  const container = document.createElement("div");
  container.style.padding = "4rem";
  document.body.append(container);
  root = createRoot(container);
  root.render(ui);
}

afterEach(() => {
  root?.unmount();
  document.body.replaceChildren();
});

const tooltip = (text) => page.getByRole("tooltip", { includeHidden: true }).filter({ hasText: text });

test("keyboard focus shows the tooltip and moving focus away hides it", async () => {
  render(
    <>
      <TooltipButton label="Play next">▶</TooltipButton>
      <button type="button">After</button>
    </>,
  );

  await userEvent.tab();
  await expect.element(page.getByRole("button", { name: "Play next" })).toHaveFocus();
  await expect.element(tooltip("Play next")).toBeVisible();

  await userEvent.tab();
  await expect.element(tooltip("Play next")).not.toBeVisible();
});

test("a mouse click does not keep the tooltip open after the pointer leaves", async () => {
  render(<TooltipButton label="Shuffle">⤮</TooltipButton>);
  const button = page.getByRole("button", { name: "Shuffle" });

  await userEvent.click(button);
  await expect.element(button).toHaveFocus();
  await expect.element(tooltip("Shuffle")).toBeVisible();

  await userEvent.unhover(button);
  await expect.element(tooltip("Shuffle")).not.toBeVisible();
});

test("Escape dismisses a hovered tooltip until the pointer enters again", async () => {
  render(<TooltipButton label="Repeat">↻</TooltipButton>);
  const button = page.getByRole("button", { name: "Repeat" });

  await userEvent.hover(button);
  await expect.element(tooltip("Repeat")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(tooltip("Repeat")).not.toBeVisible();

  await userEvent.unhover(button);
  await userEvent.hover(button);
  await expect.element(tooltip("Repeat")).toBeVisible();
});

test("an icon-only control is named by its tooltip without repeating it as a description", async () => {
  render(
    <Tooltip content="Remove from queue">
      <button type="button">
        <svg aria-hidden="true" width="16" height="16" />
      </button>
    </Tooltip>,
  );
  const button = page.getByRole("button", { name: "Remove from queue" });

  await userEvent.hover(button);
  await expect.element(tooltip("Remove from queue")).toBeVisible();
  await expect.element(button).not.toHaveAttribute("aria-describedby");
});

test("a labelled control gets the tooltip as its description while it is visible", async () => {
  render(
    <Tooltip content="Removes every track you have not played yet">
      <button type="button">Clear queue</button>
    </Tooltip>,
  );
  const button = page.getByRole("button", { name: "Clear queue" });

  await userEvent.hover(button);
  await expect.element(button).toHaveAccessibleDescription("Removes every track you have not played yet");
});

test("the tooltip stays inside the viewport next to a control at the right edge", async () => {
  render(
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <TooltipButton label="Open the full settings page for this library">⚙</TooltipButton>
    </div>,
  );
  const button = page.getByRole("button", { name: "Open the full settings page for this library" });

  await userEvent.hover(button);
  const element = tooltip("Open the full settings page").element();
  await expect.element(element).toBeVisible();

  const rect = element.getBoundingClientRect();
  const buttonRect = button.element().getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.right).toBeLessThanOrEqual(buttonRect.left);
});
