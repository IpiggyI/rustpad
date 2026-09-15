import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CurrentBlockStorage,
  chooseReplacementBlockId,
  currentBlockStorageKey,
  loadCurrentBlockId,
  resolveCurrentBlockId,
  saveCurrentBlockId,
} from "../src/currentBlock.ts";

function block(
  id: string,
  title: string = "Notes",
): { id: string; title: string } {
  return { id, title };
}

function createMemoryStorage(
  initial: Record<string, string> = {},
): CurrentBlockStorage & { data: Map<string, string>; removed: string[] } {
  const data = new Map(Object.entries(initial));
  const removed: string[] = [];
  return {
    data,
    removed,
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      removed.push(key);
      data.delete(key);
    },
  };
}

const a = block("aaaaaa");
const b = block("bbbbbb");
const c = block("cccccc");
const d = block("dddddd");

test("storage key follows documentTitle:page:${id}", () => {
  assert.equal(currentBlockStorageKey("abc123"), "currentBlock:page:abc123");
  assert.notEqual(
    currentBlockStorageKey("page-a"),
    currentBlockStorageKey("page-b"),
  );
});

test("no stored record selects the first block", () => {
  const list = [a, b, c];
  assert.equal(resolveCurrentBlockId(null, list), "aaaaaa");
  assert.equal(resolveCurrentBlockId(undefined, list), "aaaaaa");
  assert.equal(resolveCurrentBlockId("", list), "aaaaaa");
});

test("empty list has no current block", () => {
  assert.equal(resolveCurrentBlockId("aaaaaa", []), null);
  assert.equal(resolveCurrentBlockId(null, []), null);
});

test("a stored id that still exists is kept, including after reorder", () => {
  assert.equal(resolveCurrentBlockId("bbbbbb", [a, b, c]), "bbbbbb");
  assert.equal(resolveCurrentBlockId("bbbbbb", [c, a, b]), "bbbbbb");
  assert.equal(resolveCurrentBlockId("aaaaaa", [c, b, a]), "aaaaaa");
});

test("a stored id that no longer exists falls back to the first block", () => {
  assert.equal(resolveCurrentBlockId("goneee", [a, b, c]), "aaaaaa");
  assert.equal(resolveCurrentBlockId("bbbbbb", [a, c]), "aaaaaa");
});

test("two blocks with the same title are distinguished by id", () => {
  const first = block("aaaaaa", "Notes");
  const second = block("bbbbbb", "Notes");
  const list = [first, second];
  assert.equal(resolveCurrentBlockId("bbbbbb", list), "bbbbbb");
  assert.equal(resolveCurrentBlockId("aaaaaa", list), "aaaaaa");
  assert.notEqual(first.title, undefined);
  assert.equal(first.title, second.title);
});

test("deleting a non-current block leaves the selection alone", () => {
  assert.equal(resolveCurrentBlockId("aaaaaa", [a, c]), "aaaaaa");
  assert.equal(resolveCurrentBlockId("cccccc", [a, c]), "cccccc");
});

test("deleting the current block from the middle selects the next", () => {
  assert.equal(chooseReplacementBlockId([a, b, c], [a, c], "bbbbbb"), "cccccc");
});

test("deleting the current block from the end selects the previous", () => {
  assert.equal(chooseReplacementBlockId([a, b, c], [a, b], "cccccc"), "bbbbbb");
});

test("deleting the only block clears the selection", () => {
  assert.equal(chooseReplacementBlockId([a], [], "aaaaaa"), null);
});

test("when the next neighbour is also gone, skip to the following survivor", () => {
  assert.equal(
    chooseReplacementBlockId([a, b, c, d], [a, d], "bbbbbb"),
    "dddddd",
  );
});

test("remote deletion with unknown previous order selects the first current block", () => {
  assert.equal(chooseReplacementBlockId(null, [a, c], "bbbbbb"), "aaaaaa");
  assert.equal(chooseReplacementBlockId(undefined, [a, c], "bbbbbb"), "aaaaaa");
  assert.equal(chooseReplacementBlockId([], [a, c], "bbbbbb"), "aaaaaa");
  assert.equal(chooseReplacementBlockId([a, c], [a, c], "bbbbbb"), "aaaaaa");
});

test("unknown previous order on an empty list clears the selection", () => {
  assert.equal(chooseReplacementBlockId(null, [], "aaaaaa"), null);
});

test("load returns null when no record is stored", () => {
  const storage = createMemoryStorage();
  assert.equal(loadCurrentBlockId("page-a", storage), null);
});

test("save then load round-trips a block id", () => {
  const storage = createMemoryStorage();
  saveCurrentBlockId("page-a", "bbbbbb", storage);
  assert.equal(storage.getItem("currentBlock:page:page-a"), "bbbbbb");
  assert.equal(loadCurrentBlockId("page-a", storage), "bbbbbb");
});

test("two page ids do not share a selection", () => {
  const storage = createMemoryStorage();
  saveCurrentBlockId("page-a", "aaaaaa", storage);
  saveCurrentBlockId("page-b", "bbbbbb", storage);
  assert.equal(loadCurrentBlockId("page-a", storage), "aaaaaa");
  assert.equal(loadCurrentBlockId("page-b", storage), "bbbbbb");
  assert.equal(storage.getItem("currentBlock:page:page-a"), "aaaaaa");
  assert.equal(storage.getItem("currentBlock:page:page-b"), "bbbbbb");
});

test("saving null removes a stored id so it cannot point at a missing block", () => {
  const storage = createMemoryStorage({
    "currentBlock:page:page-a": "aaaaaa",
  });
  saveCurrentBlockId("page-a", null, storage);
  assert.equal(loadCurrentBlockId("page-a", storage), null);
  assert.equal(storage.getItem("currentBlock:page:page-a"), null);
  assert.deepEqual(storage.removed, ["currentBlock:page:page-a"]);
});

test("a stale stored id is overwritten when the resolved id is saved", () => {
  const storage = createMemoryStorage({
    "currentBlock:page:page-a": "goneee",
  });
  const resolved = resolveCurrentBlockId(
    loadCurrentBlockId("page-a", storage),
    [a, b],
  );
  assert.equal(resolved, "aaaaaa");
  saveCurrentBlockId("page-a", resolved, storage);
  assert.equal(loadCurrentBlockId("page-a", storage), "aaaaaa");
  assert.equal(storage.getItem("currentBlock:page:page-a"), "aaaaaa");
});

test("clearing after an empty list does not leave a stored id", () => {
  const storage = createMemoryStorage({
    "currentBlock:page:page-a": "aaaaaa",
  });
  const resolved = resolveCurrentBlockId(
    loadCurrentBlockId("page-a", storage),
    [],
  );
  assert.equal(resolved, null);
  saveCurrentBlockId("page-a", resolved, storage);
  assert.equal(loadCurrentBlockId("page-a", storage), null);
  assert.equal(storage.getItem("currentBlock:page:page-a"), null);
});

test("load treats an empty stored value as no record", () => {
  const storage = createMemoryStorage({
    "currentBlock:page:page-a": "",
  });
  assert.equal(loadCurrentBlockId("page-a", storage), null);
});

test("load does not throw when getItem throws", () => {
  const storage = createMemoryStorage();
  storage.getItem = () => {
    throw new Error("read failed");
  };
  assert.equal(loadCurrentBlockId("page-a", storage), null);
});

test("save does not throw when setItem or removeItem fails", () => {
  const storage = createMemoryStorage();
  storage.setItem = () => {
    throw new Error("quota");
  };
  storage.removeItem = () => {
    throw new Error("denied");
  };
  assert.doesNotThrow(() => {
    saveCurrentBlockId("page-a", "aaaaaa", storage);
    saveCurrentBlockId("page-a", null, storage);
  });
});

test("resolve does not mutate the block list", () => {
  const list = Object.freeze([
    Object.freeze({ ...a }),
    Object.freeze({ ...b }),
  ]);
  const before = structuredClone(list);
  resolveCurrentBlockId("bbbbbb", list);
  assert.deepEqual(list, before);
});
