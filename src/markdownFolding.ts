import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

function isEmptyFoldRecord(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

type Monaco = typeof monaco;

/** Compute folding ranges for ATX headings (`#` ~ `######`), skipping code fences. */
function computeHeadingRanges(
  lines: string[],
): monaco.languages.FoldingRange[] {
  const ranges: monaco.languages.FoldingRange[] = [];
  const stack: { level: number; start: number }[] = [];
  let fenceChar: string | null = null;

  const close = (level: number, endLine: number) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      const open = stack.pop()!;
      if (endLine > open.start) {
        ranges.push({ start: open.start, end: endLine });
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (fenceChar === null) {
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar) {
        fenceChar = null;
      }
      continue;
    }
    if (fenceChar !== null) {
      continue;
    }
    const heading = line.match(/^(#{1,6})\s/);
    if (heading) {
      const level = heading[1].length;
      close(level, i); // fold up to the line before this heading (1-based: i)
      stack.push({ level, start: i + 1 });
    }
  }
  close(0, lines.length);
  return ranges;
}

export function registerMarkdownFolding(m: Monaco) {
  m.languages.registerFoldingRangeProvider("markdown", {
    provideFoldingRanges: (model) =>
      computeHeadingRanges(model.getLinesContent()),
  });
}

const FOLDING_CONTRIBUTION_ID = "editor.contrib.folding";

type FoldingModelHandle = {
  getMemento(): unknown;
  applyMemento(state: unknown): void;
  readonly regions?: { readonly length: number };
  onDidChange?: (listener: () => void) => { dispose(): void };
};

type FoldingContribution = monaco.editor.IEditorContribution & {
  getFoldingModel?: () => Promise<FoldingModelHandle | null> | null;
  foldingModel?: FoldingModelHandle | null;
  restoreViewState?: (state: { collapsedRegions?: unknown }) => void;
};

/** monaco-editor ^0.52.2 FoldingController fields used to hold updates. */
export type FoldingImeHoldTarget = {
  triggerFoldingModelChanged?: (...args: unknown[]) => unknown;
  foldingRegionPromise?: { cancel?: () => void } | null;
  updateScheduler?: { cancel?: () => void } | null;
};

export type FoldingImeHold = {
  start(): void;
  end(): void;
  dispose(): void;
};

const foldingImeHeldEditors = new WeakSet<object>();

function getFoldingContribution(
  ed: monaco.editor.ICodeEditor,
): (FoldingContribution & FoldingImeHoldTarget) | null {
  try {
    return (
      ed.getContribution<FoldingContribution & FoldingImeHoldTarget>(
        FOLDING_CONTRIBUTION_ID,
      ) ?? null
    );
  } catch {
    return null;
  }
}

async function waitForFoldingModel(
  ed: monaco.editor.ICodeEditor,
): Promise<FoldingModelHandle | null> {
  const contribution = getFoldingContribution(ed);
  if (!contribution) return null;
  const pending = contribution.getFoldingModel?.() ?? null;
  if (!pending) return contribution.foldingModel ?? null;
  const model = await pending;
  const latest = contribution.getFoldingModel?.() ?? null;
  if (latest && latest !== pending) {
    return (await latest) ?? contribution.foldingModel ?? null;
  }
  return model ?? contribution.foldingModel ?? null;
}

/**
 * Unread: no model, or regions.length === 0 (compute has not produced ranges).
 * Cleared: regions exist and getMemento() is undefined — monaco-editor ^0.52.2
 * returns undefined when nothing is collapsed, not [].
 */
function mementoFromHandle(
  model: FoldingModelHandle | null | undefined,
): unknown {
  if (!model) return undefined;
  const regionCount = model.regions?.length ?? 0;
  if (regionCount === 0) return undefined;
  const memento = model.getMemento();
  return memento === undefined ? [] : memento;
}

export function isFoldingImeHeld(ed: monaco.editor.ICodeEditor): boolean {
  return foldingImeHeldEditors.has(ed);
}

/**
 * Hold monaco-editor ^0.52.2 FoldingController.triggerFoldingModelChanged for
 * the whole composition. Cancelling the scheduler only at compositionstart
 * loses the candidate pause (>= 200ms debounce) to a later content change.
 */
export function createFoldingImeHold(
  contribution: FoldingImeHoldTarget | null | undefined,
): FoldingImeHold {
  let original: ((...args: unknown[]) => unknown) | undefined;
  let wrapped = false;

  const start = () => {
    if (!contribution) return;
    try {
      contribution.foldingRegionPromise?.cancel?.();
      contribution.foldingRegionPromise = null;
      contribution.updateScheduler?.cancel?.();
      const current = contribution.triggerFoldingModelChanged;
      if (!wrapped && typeof current === "function") {
        original = current;
        contribution.triggerFoldingModelChanged = () => undefined;
        wrapped = true;
      }
    } catch {
      // Missing FoldingController fields must not throw into IME handling.
    }
  };

  const restoreMethod = () => {
    if (!contribution || !wrapped) return;
    contribution.triggerFoldingModelChanged = original;
    wrapped = false;
    original = undefined;
  };

  const end = () => {
    if (!contribution) return;
    try {
      const trigger = original;
      const shouldTrigger = wrapped && typeof trigger === "function";
      restoreMethod();
      if (shouldTrigger) {
        trigger.call(contribution);
      }
    } catch {
      // Missing FoldingController fields must not throw into IME handling.
    }
  };

  const dispose = () => {
    try {
      restoreMethod();
    } catch {
      // Missing FoldingController fields must not throw into IME handling.
    }
  };

  return { start, end, dispose };
}

export function attachFoldingImeHold(
  editor: monaco.editor.ICodeEditor,
): FoldingImeHold {
  const hold = createFoldingImeHold(getFoldingContribution(editor));
  return {
    start() {
      foldingImeHeldEditors.add(editor);
      hold.start();
    },
    end() {
      hold.end();
      foldingImeHeldEditors.delete(editor);
    },
    dispose() {
      hold.dispose();
      foldingImeHeldEditors.delete(editor);
    },
  };
}

export async function readFoldRecord(
  ed: monaco.editor.ICodeEditor,
): Promise<unknown> {
  if (isFoldingImeHeld(ed)) return undefined;
  return mementoFromHandle(await waitForFoldingModel(ed));
}

/** Live folding-model memento; used on unmount where a debounce must not be dropped. */
export function readFoldRecordSync(ed: monaco.editor.ICodeEditor): unknown {
  if (isFoldingImeHeld(ed)) return undefined;
  const contribution = getFoldingContribution(ed);
  return mementoFromHandle(contribution?.foldingModel);
}

function sameFoldSpan(left: unknown, right: unknown): boolean {
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const a = left as { startLineNumber?: unknown; endLineNumber?: unknown };
  const b = right as { startLineNumber?: unknown; endLineNumber?: unknown };
  return (
    a.startLineNumber === b.startLineNumber &&
    a.endLineNumber === b.endLineNumber
  );
}

function collapsedRangesMatch(record: unknown, live: unknown): boolean {
  if (!Array.isArray(record) || record.length === 0) return true;
  if (!Array.isArray(live)) return false;
  return record.some((wanted) =>
    live.some((item) => sameFoldSpan(wanted, item)),
  );
}

function restoreHasSettled(
  model: FoldingModelHandle,
  record: unknown,
): boolean {
  const live = model.getMemento();
  if (collapsedRangesMatch(record, live === undefined ? [] : live)) {
    return true;
  }
  return (model.regions?.length ?? 0) > 0;
}

function applyFoldRestore(
  contribution: FoldingContribution | null,
  model: FoldingModelHandle,
  record: unknown,
): void {
  try {
    if (typeof contribution?.restoreViewState === "function") {
      // monaco-editor ^0.52.2 sets _restoringViewState around applyMemento so
      // revealCursor / hidden-range selection adjustment cannot unfold us.
      contribution.restoreViewState({ collapsedRegions: record });
      return;
    }
  } catch {
    // Fall back to applyMemento when restoreViewState is missing or throws.
  }
  try {
    model.applyMemento(record);
  } catch {
    // Restore must not throw into editor lifecycle.
  }
}

export async function restoreFoldRecord(
  ed: monaco.editor.ICodeEditor,
  record: unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || isFoldingImeHeld(ed) || isEmptyFoldRecord(record)) {
    return;
  }
  const contribution = getFoldingContribution(ed);
  const model = await waitForFoldingModel(ed);
  if (
    !model ||
    signal?.aborted ||
    isFoldingImeHeld(ed) ||
    isEmptyFoldRecord(record)
  ) {
    return;
  }
  applyFoldRestore(contribution, model, record);
  if (restoreHasSettled(model, record)) {
    return;
  }

  const currentModel = () => getFoldingContribution(ed)?.foldingModel ?? model;

  await new Promise<void>((resolve) => {
    let finished = false;
    let subscription: { dispose(): void } | undefined;

    const finish = () => {
      if (finished) return;
      finished = true;
      subscription?.dispose();
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    const retry = () => {
      if (finished || signal?.aborted || isFoldingImeHeld(ed)) {
        finish();
        return;
      }
      const latest = currentModel();
      applyFoldRestore(getFoldingContribution(ed), latest, record);
      if (restoreHasSettled(latest, record)) {
        finish();
      }
    };

    signal?.addEventListener("abort", finish);
    if (signal?.aborted) {
      finish();
      return;
    }
    try {
      subscription = model.onDidChange?.(retry);
    } catch {
      finish();
      return;
    }
    if (!subscription) {
      finish();
    }
  });
}
