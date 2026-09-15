import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blockPresentationStorageKey,
  loadBlockPresentation,
  resolveBlockPresentation,
  saveBlockPresentation,
} from "../src/blockPresentation.ts";

test("presentation defaults to single and accepts only known stored choices", () => {
  for (const value of [null, undefined, "", "unknown", "single"]) {
    assert.equal(resolveBlockPresentation(value), "single");
  }
  assert.equal(resolveBlockPresentation("stacked"), "stacked");
});

test("presentation storage is isolated by page and by device", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  assert.equal(blockPresentationStorageKey("a"), "blockPresentation:page:a");
  assert.equal(loadBlockPresentation("a", storage), "single");
  saveBlockPresentation("a", "stacked", storage);
  assert.equal(loadBlockPresentation("a", storage), "stacked");
  assert.equal(loadBlockPresentation("b", storage), "single");
  assert.equal(
    loadBlockPresentation("a", { ...storage, getItem: () => null }),
    "single",
  );
  saveBlockPresentation("a", "single", storage);
  assert.equal(loadBlockPresentation("a", storage), "single");
});

test("unavailable preference storage leaves editing usable", () => {
  const fail = () => {
    throw new Error("Storage denied");
  };
  const storage = { getItem: fail, setItem: fail, removeItem: fail };
  assert.equal(loadBlockPresentation("a", storage), "single");
  assert.doesNotThrow(() => saveBlockPresentation("a", "stacked", storage));
});
