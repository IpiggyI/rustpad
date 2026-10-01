/**
 * Copies text when the page is a secure context and when it is not.
 * `navigator.clipboard` is absent on plain http origins, so a rejected or
 * missing `writeText` uses an off-screen textarea and `document.execCommand`.
 */

type SelectionDirection = "forward" | "backward" | "none";

type TextSelection = {
  start: number;
  end: number;
  direction: SelectionDirection;
};

type SavedFocus = {
  element: Element | null;
  text: TextSelection | null;
  ranges: Range[];
};

const SELECTABLE_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "password",
]);

const COPY_DENIED = "Clipboard access was denied by the browser.";

export async function copyText(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return;
    } catch (error) {
      try {
        copyWithCommand(text);
        return;
      } catch {
        // The textarea fallback failed too. Keep the clipboard error so the
        // existing toast description stays the one writeText produced.
        throw error;
      }
    }
  }
  copyWithCommand(text);
}

function copyWithCommand(text: string): void {
  const saved = captureFocus();
  const textarea = document.createElement("textarea");
  textarea.value = text;
  prepareFallbackTextarea(textarea);
  const parent = document.body;
  if (!parent) throw new Error(COPY_DENIED);
  parent.appendChild(textarea);
  let copied = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
    restoreFocus(saved);
  }
  if (!copied) throw new Error(COPY_DENIED);
}

function prepareFallbackTextarea(textarea: HTMLTextAreaElement): void {
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.setAttribute("data-rustpad-copy-fallback", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
}

function captureFocus(): SavedFocus {
  const element = document.activeElement;
  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index).cloneRange());
    }
  }
  return { element, text: textSelection(element), ranges };
}

function textSelection(element: Element | null): TextSelection | null {
  if (element instanceof HTMLTextAreaElement) {
    return readSelection(element);
  }
  if (
    element instanceof HTMLInputElement &&
    SELECTABLE_INPUT_TYPES.has(element.type)
  ) {
    return readSelection(element);
  }
  return null;
}

function readSelection(
  element: HTMLInputElement | HTMLTextAreaElement,
): TextSelection | null {
  if (element.selectionStart == null || element.selectionEnd == null) {
    return null;
  }
  return {
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection ?? "none",
  };
}

function restoreFocus(saved: SavedFocus): void {
  focusElement(saved.element);
  if (restoreTextSelection(saved)) return;
  restoreRanges(saved.ranges);
}

function focusElement(element: Element | null): void {
  if (
    (element instanceof HTMLElement || element instanceof SVGElement) &&
    element.isConnected
  ) {
    element.focus({ preventScroll: true });
  }
}

function restoreTextSelection(saved: SavedFocus): boolean {
  const { element, text } = saved;
  if (
    !text ||
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) ||
    !element.isConnected
  ) {
    return false;
  }
  element.setSelectionRange(text.start, text.end, text.direction);
  return true;
}

function restoreRanges(ranges: Range[]): void {
  const selection = document.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  for (const range of ranges) {
    if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
      continue;
    }
    try {
      selection.addRange(range);
    } catch {
      // The document rejected this range. The copy has already completed.
    }
  }
}
