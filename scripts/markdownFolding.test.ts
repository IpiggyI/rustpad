import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldPersistSingleDocFolds } from "../src/manifestOps.ts";
import {
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

function fakeEditor(foldingModel, contribution = {}) {
  return {
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
