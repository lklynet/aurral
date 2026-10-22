import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";
import { createRoot } from "react-dom/client";
import { Toast } from "../../frontend/src/components/Toast.tsx";

let root;

afterEach(() => {
  vi.restoreAllMocks();
  root?.unmount();
  document.body.replaceChildren();
});

test("a toast still dismisses after the pointer leaves it for outside the app", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const onDismiss = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <Toast toast={{ id: "t1", message: "Saved", duration: 400 }} onDismiss={onDismiss} />,
  );

  const toast = page.getByRole("status");
  await userEvent.hover(toast);
  const element = container.querySelector(".app-toast");
  element.dispatchEvent(
    new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
  );

  await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledWith("t1"), { timeout: 3000 });
});
