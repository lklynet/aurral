const TEXT_ENTRY_TYPES = new Set(["text", "search", "url", "email", "password", "number", "tel"]);

const isTextEntry = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLInputElement && TEXT_ENTRY_TYPES.has(element.type)) ||
  (element instanceof HTMLElement && element.isContentEditable);

export function afterTextEntry(commit: () => void) {
  const active = document.activeElement;
  if (isTextEntry(active)) active.addEventListener("blur", commit, { once: true });
  else commit();
}
