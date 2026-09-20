import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

function isEmptyFoldRecord(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

type Monaco = typeof monaco;

type CollapsedRegion = { startLineNumber: number; endLineNumber: number };
type FoldRange = CollapsedRegion & { isCollapsed: boolean; source: number };

export function planHeadingEnter(input: {
  lines: string[];
  language: string;
  position: { lineNumber: number; column: number };
  cursorCount: number;
  selectionEmpty: boolean;
  collapsedRegions: CollapsedRegion[];
}) {
  const { lines, position } = input;
  const line = lines[position.lineNumber - 1];
  const heading = line?.match(/^(#{1,6})\s/);
  const region = input.collapsedRegions.find(
    (region) => region.startLineNumber === position.lineNumber,
  );
  if (
    input.language !== "markdown" ||
    input.cursorCount !== 1 ||
    !input.selectionEmpty ||
    !heading ||
    !region ||
    position.column !== line.length + 1
  )
    return null;
  const prefix = `${heading[1]} `;
  const atEnd = region.endLineNumber === lines.length;
  return {
    lineNumber: atEnd ? region.endLineNumber : region.endLineNumber + 1,
    column: atEnd ? lines[region.endLineNumber - 1].length + 1 : 1,
    text: atEnd ? `\n${prefix}` : `${prefix}\n`,
    caretLineNumber: region.endLineNumber + 1,
    caretColumn: prefix.length + 1,
  };
}

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

type FoldingRegionsHandle = {
  readonly length: number;
  isCollapsed(index: number): boolean;
  getStartLineNumber(index: number): number;
  getEndLineNumber(index: number): number;
  toFoldRange?(index: number): FoldRange;
};

type FoldingModelHandle = {
  getMemento(): unknown;
  applyMemento(state: unknown): void;
  readonly regions?: FoldingRegionsHandle;
  /** monaco-editor ^0.52.2 keeps one decoration per region, in region order. */
  readonly _editorDecorationIds?: readonly string[];
  updatePost?: (regions: NonNullable<FoldingModelHandle["regions"]>) => void;
  onDidChange?: (listener: () => void) => { dispose(): void };
};

type FoldingContribution = monaco.editor.IEditorContribution & {
  getFoldingModel?: () => Promise<FoldingModelHandle | null> | null;
  foldingModel?: FoldingModelHandle | null;
  hiddenRangeModel?: { hiddenRanges: monaco.IRange[] } | null;
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

/** Hidden-area events omit edits that move existing folds or change checksums. */
export function observeFoldChanges(
  ed: monaco.editor.ICodeEditor,
  onChange: () => void,
): monaco.IDisposable {
  let folding: FoldingModelHandle | null | undefined;
  let subscription: { dispose(): void } | undefined;
  const bind = () => {
    const current = getFoldingContribution(ed)?.foldingModel;
    if (current === folding) return;
    subscription?.dispose();
    folding = current;
    subscription = current?.onDidChange?.(onChange);
  };
  const changed = () => {
    bind();
    onChange();
  };
  bind();
  const listeners = [
    ed.onDidChangeHiddenAreas(changed),
    ed.onDidChangeModelContent(changed),
    ed.onDidChangeModel(changed),
    ed.onDidChangeModelLanguage(changed),
    ed.onDidCompositionEnd(changed),
  ];
  return {
    dispose() {
      subscription?.dispose();
      listeners.forEach((listener) => listener.dispose());
    },
  };
}

/**
 * FoldingRegions carries the line numbers of the last folding computation, and
 * monaco-editor ^0.52.2 debounces that computation after every content change.
 * Read each span from its decoration instead, which the text model moves with
 * the edits — the same source FoldingModel uses when it recomputes.
 */
function collapsedRegionsOf(
  ed: monaco.editor.ICodeEditor,
  model: monaco.editor.ITextModel,
): CollapsedRegion[] {
  const folding = getFoldingContribution(ed)?.foldingModel;
  const regions = folding?.regions;
  if (!regions) return [];
  const decorationIds = folding?._editorDecorationIds ?? [];
  const collapsedRegions: CollapsedRegion[] = [];
  for (let i = 0; i < regions.length; i++) {
    if (!regions.isCollapsed(i)) continue;
    const decorationId = decorationIds[i];
    const live = decorationId ? model.getDecorationRange(decorationId) : null;
    collapsedRegions.push({
      startLineNumber: live?.startLineNumber ?? regions.getStartLineNumber(i),
      endLineNumber: live?.endLineNumber ?? regions.getEndLineNumber(i),
    });
  }
  return collapsedRegions;
}

function headingEnterEdit(ed: monaco.editor.ICodeEditor) {
  const model = ed.getModel();
  const selections = ed.getSelections();
  if (!model || !selections?.length || isFoldingImeHeld(ed)) return null;
  const collapsedRegions = collapsedRegionsOf(ed, model);
  return planHeadingEnter({
    lines: model.getLinesContent(),
    language: model.getLanguageId(),
    position: selections[0].getPosition(),
    cursorCount: selections.length,
    selectionEmpty: selections[0].isEmpty(),
    collapsedRegions,
  });
}

function refreshEofFolding(ed: monaco.editor.ICodeEditor) {
  const contribution = getFoldingContribution(ed);
  const folding = contribution?.foldingModel;
  if (!folding?.regions) return;
  // EOF insertion grows Monaco 0.52.2's collapsed decorations through the new
  // heading. Rebuild their unchanged spans before moving the cursor.
  folding.updatePost?.(folding.regions);
  const hidden = contribution?.hiddenRangeModel?.hiddenRanges;
  if (hidden) {
    const view = ed as monaco.editor.ICodeEditor & {
      setHiddenAreas(ranges: monaco.IRange[], source: unknown): void;
    };
    // An empty last line also grows the view's hidden decoration. Invalidate
    // its range cache so the unchanged folding spans reach the view again.
    view.setHiddenAreas([], contribution);
    view.setHiddenAreas(hidden, contribution);
  }
}

function executeHeadingEnter(
  ed: monaco.editor.IStandaloneCodeEditor,
  m: Monaco,
) {
  const edit = headingEnterEdit(ed);
  if (!edit) return;
  const range = m.Range.fromPositions({
    lineNumber: edit.lineNumber,
    column: edit.column,
  });
  const caret = m.Selection.fromPositions({
    lineNumber: edit.caretLineNumber,
    column: edit.caretColumn,
  });
  const atEnd = edit.caretLineNumber === ed.getModel()!.getLineCount() + 1;
  ed.pushUndoStop();
  ed.executeEdits("rustpad.headingEnter", [{ range, text: edit.text }], () => [
    caret,
  ]);
  if (atEnd) refreshEofFolding(ed);
  ed.pushUndoStop();
  ed.revealPositionInCenterIfOutsideViewport(caret.getPosition());
}

export function attachHeadingEnter(
  ed: monaco.editor.IStandaloneCodeEditor,
  m: Monaco,
): monaco.IDisposable {
  const enabled = ed.createContextKey<boolean>("rustpadHeadingEnter", false);
  const keydown = ed.onKeyDown((event) => {
    enabled.set(
      event.keyCode === m.KeyCode.Enter &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.browserEvent.isComposing &&
        event.browserEvent.keyCode !== 229 &&
        headingEnterEdit(ed) !== null,
    );
  });
  const action = ed.addAction({
    id: "rustpad.headingEnter",
    label: "Insert sibling Markdown heading",
    keybindings: [m.KeyCode.Enter],
    precondition:
      "rustpadHeadingEnter && editorTextFocus && !editorReadonly && !suggestWidgetVisible && !inSnippetMode && !findWidgetVisible",
    run: () => executeHeadingEnter(ed, m),
  });
  const disposed = ed.onDidDispose(() => disposable.dispose());
  const disposable = {
    dispose() {
      disposed.dispose();
      keydown.dispose();
      action.dispose();
      enabled.reset();
    },
  };
  return disposable;
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

/**
 * Keep only the spans that start where a heading fold starts now.
 * monaco-editor ^0.52.2 carries a collapsed span that no longer matches any
 * provided range forward as a "recovered" region, so one stale entry saved into
 * a record puts a folding arrow on a plain line on every later load.
 */
export function keepHeadingFolds(lines: string[], record: unknown): unknown {
  if (!Array.isArray(record)) return record;
  const starts = new Set(
    computeHeadingRanges(lines).map((range) => range.start),
  );
  return record.filter((span) =>
    starts.has((span as { startLineNumber?: number })?.startLineNumber ?? -1),
  );
}

function headingFoldsOnly(
  ed: monaco.editor.ICodeEditor,
  record: unknown,
): unknown {
  const model = ed.getModel();
  if (!model || model.getLanguageId() !== "markdown") return record;
  return keepHeadingFolds(model.getLinesContent(), record);
}

export async function readFoldRecord(
  ed: monaco.editor.ICodeEditor,
): Promise<unknown> {
  if (isFoldingImeHeld(ed)) return undefined;
  const textModel = ed.getModel();
  const version = textModel?.getVersionId();
  const language = textModel?.getLanguageId();
  const folding = await waitForFoldingModel(ed);
  if (
    isFoldingImeHeld(ed) ||
    ed.getModel() !== textModel ||
    textModel?.getVersionId() !== version ||
    textModel?.getLanguageId() !== language
  )
    return undefined;
  removeInvalidRecoveredFolds(ed, folding);
  return headingFoldsOnly(ed, mementoFromHandle(folding));
}

function removeInvalidRecoveredFolds(
  ed: monaco.editor.ICodeEditor,
  folding: FoldingModelHandle | null,
): void {
  const textModel = ed.getModel();
  const regions = folding?.regions;
  if (textModel?.getLanguageId() !== "markdown" || !regions?.toFoldRange)
    return;
  const starts = new Set(
    computeHeadingRanges(textModel.getLinesContent()).map((r) => r.start),
  );
  const kept = [];
  for (let i = 0; i < regions.length; i++) {
    const range = regions.toFoldRange(i);
    // Monaco 0.52.2: 1 is an explicit manual fold; 2 is a recovered provider fold.
    if (range.source !== 2 || starts.has(range.startLineNumber))
      kept.push(range);
  }
  if (kept.length === regions.length) return;
  const factory = regions.constructor as unknown as {
    fromFoldRanges(ranges: FoldRange[]): FoldingRegionsHandle;
  };
  folding?.updatePost?.(factory.fromFoldRanges(kept));
}

/** Live folding-model memento; used on unmount where a debounce must not be dropped. */
export function readFoldRecordSync(ed: monaco.editor.ICodeEditor): unknown {
  if (isFoldingImeHeld(ed)) return undefined;
  const contribution = getFoldingContribution(ed);
  return headingFoldsOnly(ed, mementoFromHandle(contribution?.foldingModel));
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
