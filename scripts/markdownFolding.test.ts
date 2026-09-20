import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldPersistSingleDocFolds } from "../src/manifestOps.ts";
import {
  keepHeadingFolds,
  readFoldRecord,
  readFoldRecordSync,
  restoreFoldRecord,
} from "../src/markdownFolding.ts";

const sampleFolds = [
  {
    startLineNumber: 1,
    endLineNumber: 4,
    isCollapsed: true,
    checksum: 42,
  },
];

function fakeEditor(foldingModel, contribution = {}, model = null) {
  return {
    getModel: () => model,
    getContribution() {
      return {
        foldingModel,
        getFoldingModel: () => Promise.resolve(foldingModel),
        ...contribution,
      };
    },
  };
}

test("regions.length === 0 read is unread and must not persist over a saved record", async () => {
  const model = {
    regions: { length: 0 },
    getMemento() {
      return undefined;
    },
    applyMemento() {},
  };
  const editor = fakeEditor(model);
  const sync = readFoldRecordSync(editor);
  const asyncRead = await readFoldRecord(editor);
  assert.equal(sync, undefined);
  assert.equal(asyncRead, undefined);
  assert.equal(shouldPersistSingleDocFolds(sync, sampleFolds, false), false);
});

test("ready model with getMemento() undefined reads [] and may persist over saved", () => {
  const model = {
    regions: { length: 3 },
    getMemento() {
      return undefined;
    },
    applyMemento() {},
  };
  const next = readFoldRecordSync(fakeEditor(model));
  assert.deepEqual(next, []);
  assert.equal(shouldPersistSingleDocFolds(next, sampleFolds, false), true);
});

test("restore prefers restoreViewState and unsubscribes after a ready miss", async () => {
  const listeners = new Set();
  let restoreCalls = 0;
  let applyCalls = 0;
  const model = {
    regions: { length: 2 },
    getMemento() {
      return undefined;
    },
    applyMemento() {
      applyCalls++;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
  };
  const editor = fakeEditor(model, {
    restoreViewState(state) {
      restoreCalls++;
      model.applyMemento(state.collapsedRegions);
    },
  });

  await restoreFoldRecord(editor, sampleFolds);
  assert.equal(restoreCalls, 1);
  assert.equal(applyCalls, 1);
  assert.equal(listeners.size, 0);

  const restoresAfter = restoreCalls;
  for (const listener of [...listeners]) listener();
  assert.equal(restoreCalls, restoresAfter);
});

test("restore retries while regions are empty then unsubscribes on match", async () => {
  const listeners = new Set();
  let regionLength = 0;
  let memento = undefined;
  let restoreCalls = 0;
  const model = {
    get regions() {
      return { length: regionLength };
    },
    getMemento() {
      return memento;
    },
    applyMemento(state) {
      if (regionLength > 0) memento = state;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
  };
  const editor = fakeEditor(model, {
    restoreViewState(state) {
      restoreCalls++;
      model.applyMemento(state.collapsedRegions);
    },
  });

  const pending = restoreFoldRecord(editor, sampleFolds);
  const started = Date.now();
  while (listeners.size === 0 && Date.now() - started < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(listeners.size, 1);

  regionLength = 2;
  for (const listener of [...listeners]) listener();
  await pending;

  assert.equal(restoreCalls >= 2, true);
  assert.deepEqual(memento, sampleFolds);
  assert.equal(listeners.size, 0);

  const restoresAfter = restoreCalls;
  regionLength = 3;
  for (const listener of [...listeners]) listener();
  assert.equal(restoreCalls, restoresAfter);
});

const headingDoc = ["## 三、风险", "测试", "无。", "## "];

test("a saved span on a plain line is dropped, heading spans are kept", () => {
  assert.deepEqual(
    keepHeadingFolds(headingDoc, [
      { startLineNumber: 1, endLineNumber: 3, isCollapsed: true },
      { startLineNumber: 2, endLineNumber: 3, isCollapsed: true },
    ]),
    [{ startLineNumber: 1, endLineNumber: 3, isCollapsed: true }],
  );
});

test("a stale end line keeps the span, monaco maps it by its start line", () => {
  assert.deepEqual(
    keepHeadingFolds(headingDoc, [
      { startLineNumber: 1, endLineNumber: 2, isCollapsed: true },
    ]),
    [{ startLineNumber: 1, endLineNumber: 2, isCollapsed: true }],
  );
});

test("a heading with no body owns no fold, so its span is dropped", () => {
  assert.deepEqual(
    keepHeadingFolds(headingDoc, [
      { startLineNumber: 4, endLineNumber: 4, isCollapsed: true },
    ]),
    [],
  );
});

test("a heading inside a code fence owns no fold", () => {
  assert.deepEqual(
    keepHeadingFolds(
      ["# Real", "```", "## Fenced", "text", "```"],
      [{ startLineNumber: 3, endLineNumber: 4, isCollapsed: true }],
    ),
    [],
  );
});

test("a record that is not an array passes through untouched", () => {
  assert.equal(keepHeadingFolds(headingDoc, undefined), undefined);
});

for (const change of ["version", "language", "model"]) {
  test(`an asynchronous fold read cannot cross a ${change} change`, async () => {
    let version = 1;
    let language = "json";
    const textModel = {
      getVersionId: () => version,
      getLanguageId: () => language,
    };
    let current = textModel;
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const folding = { regions: { length: 1 }, getMemento: () => sampleFolds };
    const editor = {
      getModel: () => current,
      getContribution: () => ({
        foldingModel: folding,
        getFoldingModel: () => pending,
      }),
    };
    const result = readFoldRecord(editor);
    if (change === "version") version++;
    if (change === "language") language = "xml";
    if (change === "model") current = { ...textModel };
    finish(folding);
    assert.equal(await result, undefined);
  });
}
