import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let bodyScrollLockCount = 0;
let previousBodyOverflow = "";
const openDialogStack = [];
const isolatedElementState = new WeakMap();

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true",
  );
}

function lockBodyScroll() {
  if (bodyScrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLockCount += 1;
}

function unlockBodyScroll() {
  bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
  if (bodyScrollLockCount === 0) {
    document.body.style.overflow = previousBodyOverflow;
  }
}

function isolateElement(element) {
  const current = isolatedElementState.get(element);
  if (current) {
    current.count += 1;
    return;
  }

  isolatedElementState.set(element, {
    count: 1,
    hadInertAttribute: element.hasAttribute("inert"),
    inert: element.inert,
    ariaHidden: element.getAttribute("aria-hidden"),
  });
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

function restoreElement(element) {
  const state = isolatedElementState.get(element);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;

  if (state.hadInertAttribute) {
    element.setAttribute("inert", "");
  } else {
    element.removeAttribute("inert");
  }
  element.inert = state.inert;
  if (state.ariaHidden === null) {
    element.removeAttribute("aria-hidden");
  } else {
    element.setAttribute("aria-hidden", state.ariaHidden);
  }
  isolatedElementState.delete(element);
}

function isolateDialogBackground(dialog) {
  const isolated = [];
  let branch = dialog;

  while (branch?.parentElement && branch.parentElement !== document.body) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (sibling === branch || sibling.contains(dialog)) continue;
      isolateElement(sibling);
      isolated.push(sibling);
    }
    branch = parent;
  }

  if (branch?.parentElement === document.body) {
    for (const sibling of document.body.children) {
      if (sibling === branch || sibling.contains(dialog)) continue;
      isolateElement(sibling);
      isolated.push(sibling);
    }
  }

  return () => {
    for (const element of isolated.reverse()) restoreElement(element);
  };
}

export function useModalDialog({ open, onClose, closeDisabled = false, initialFocusRef }) {
  const dialogRef = useRef(null);
  const dialogIdRef = useRef(Symbol("modal-dialog"));
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);

  onCloseRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    const dialogId = dialogIdRef.current;
    openDialogStack.push(dialogId);
    lockBodyScroll();

    let restoreBackground = null;
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog || openDialogStack[openDialogStack.length - 1] !== dialogId) return;
      const preferredFocus = initialFocusRef?.current || dialog.querySelector("[autofocus]");
      const nextFocus = preferredFocus || getFocusableElements(dialog)[0] || dialog;
      nextFocus.focus({ preventScroll: true });
      restoreBackground = isolateDialogBackground(dialog);
    }, 0);

    const handleKeyDown = (event) => {
      const dialog = dialogRef.current;
      if (!dialog || openDialogStack[openDialogStack.length - 1] !== dialogId) return;

      if (event.key === "Escape" && !closeDisabledRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      const stackIndex = openDialogStack.lastIndexOf(dialogId);
      if (stackIndex >= 0) openDialogStack.splice(stackIndex, 1);
      unlockBodyScroll();
      restoreBackground?.();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [initialFocusRef, open]);

  const handleBackdropClick = (event) => {
    const isTopmost = openDialogStack[openDialogStack.length - 1] === dialogIdRef.current;
    if (event.target === event.currentTarget && isTopmost && !closeDisabledRef.current) {
      onCloseRef.current?.();
    }
  };

  return { dialogRef, handleBackdropClick };
}
