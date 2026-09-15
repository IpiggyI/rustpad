import type { CurrentBlockStorage } from "./currentBlock";

export type BlockPresentation = "single" | "stacked";

export function blockPresentationStorageKey(pageId: string): string {
  return `blockPresentation:page:${pageId}`;
}

export function resolveBlockPresentation(
  stored: string | null | undefined,
): BlockPresentation {
  return stored === "stacked" ? "stacked" : "single";
}

export function loadBlockPresentation(
  pageId: string,
  storage?: CurrentBlockStorage,
): BlockPresentation {
  try {
    return resolveBlockPresentation(
      (storage ?? window.localStorage).getItem(
        blockPresentationStorageKey(pageId),
      ),
    );
  } catch {
    return "single";
  }
}

export function saveBlockPresentation(
  pageId: string,
  presentation: BlockPresentation,
  storage?: CurrentBlockStorage,
): void {
  try {
    (storage ?? window.localStorage).setItem(
      blockPresentationStorageKey(pageId),
      presentation,
    );
  } catch {
    // A device preference must never interrupt editing.
  }
}
