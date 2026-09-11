import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachFoldingImeHold,
  createFoldingImeHold,
  isFoldingImeHeld,
  restoreFoldRecord,
} from "../src/markdownFolding.ts";

test("composition start no-ops triggerFoldingModelChanged; end calls original once", () => {
  let calls = 0;
  const promise = {
    cancelCalls: 0,
    cancel() {
      this.cancelCalls++;
    },
  };
  const scheduler = {
    cancelCalls: 0,
    cancel() {
      this.cancelCalls++;
    },
  };
  const controller = {
    triggerFoldingModelChanged() {
      calls++;
    },
    foldingRegionPromise: promise,
    updateScheduler: scheduler,
  };
  const hold = createFoldingImeHold(controller);

  hold.start();
  assert.equal(promise.cancelCalls, 1);
  assert.equal(controller.foldingRegionPromise, null);
  assert.equal(scheduler.cancelCalls, 1);

  controller.triggerFoldingModelChanged();
  controller.triggerFoldingModelChanged();
  assert.equal(calls, 0);

  hold.end();
  assert.equal(calls, 1);
});

test("missing FoldingController fields do not throw", () => {
  assert.doesNotThrow(() => {
    const hold = createFoldingImeHold(undefined);
    hold.start();
    hold.end();
    hold.dispose();
  });
  assert.doesNotThrow(() => {
    const hold = createFoldingImeHold({});
    hold.start();
    hold.end();
    hold.dispose();
  });
});

test("restore is a no-op while the folding IME hold is active", async () => {
  let restoreCalls = 0;
  const record = [
    {
      startLineNumber: 1,
      endLineNumber: 4,
      isCollapsed: true,
      checksum: 1,
    },
  ];
  const model = {
    regions: { length: 2 },
    getMemento() {
      return undefined;
    },
    applyMemento() {
      restoreCalls++;
    },
  };
  const editor = {
    getContribution() {
      return {
        foldingModel: model,
        getFoldingModel: () => Promise.resolve(model),
        restoreViewState() {
          restoreCalls++;
          model.applyMemento(record);
        },
      };
    },
  };
  const hold = attachFoldingImeHold(editor);
  hold.start();
  assert.equal(isFoldingImeHeld(editor), true);
  await restoreFoldRecord(editor, record);
  assert.equal(restoreCalls, 0);
  hold.end();
  assert.equal(isFoldingImeHeld(editor), false);
});
