import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BlockSnapshot,
  type SnapshotStorage,
  loadBlockSnapshot,
  saveBlockSnapshot,
} from "../src/blockModeSync.ts";

const PREFIX = "block-workspace:snapshot:";

function quotaError(): DOMException {
  return new DOMException("The quota has been exceeded.", "QuotaExceededError");
}

function snapshot(
  content: string,
  extra?: Partial<BlockSnapshot>,
): BlockSnapshot {
  return {
    version: 1,
    blocks: [
      {
        id: "aaaaaa",
        title: "Notes",
        language: "markdown",
        content,
      },
    ],
    ...extra,
  };
}

function storedSnapshot(
  content: string,
  lastAccessedAt?: number,
): BlockSnapshot {
  const value = snapshot(content);
  if (lastAccessedAt !== undefined) value.lastAccessedAt = lastAccessedAt;
  return value;
}

function createMemoryStorage(
  initial: Record<string, string> = {},
): SnapshotStorage & { data: Map<string, string>; removed: string[] } {
  const data = new Map(Object.entries(initial));
  const removed: string[] = [];
  return {
    data,
    removed,
    get length() {
      return data.size;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
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

function withSetItem(
  inner: SnapshotStorage,
  setItem: (key: string, value: string) => void,
): SnapshotStorage {
  return {
    get length() {
      return inner.length;
    },
    key: (index: number) => inner.key(index),
    getItem: (key: string) => inner.getItem(key),
    removeItem: (key: string) => inner.removeItem(key),
    setItem,
  };
}

function seedPage(
  storage: SnapshotStorage,
  pageId: string,
  content: string,
  lastAccessedAt?: number,
) {
  const value = storedSnapshot(content, lastAccessedAt);
  if (lastAccessedAt === undefined) delete value.lastAccessedAt;
  storage.setItem(`${PREFIX}${pageId}`, JSON.stringify(value));
}

function readRaw(storage: SnapshotStorage, pageId: string): BlockSnapshot {
  const raw = storage.getItem(`${PREFIX}${pageId}`);
  assert.ok(raw, `expected snapshot for ${pageId}`);
  return JSON.parse(raw) as BlockSnapshot;
}

function hasBlockBody(value: string): boolean {
  const parsed = JSON.parse(value) as BlockSnapshot;
  return parsed.blocks.some((block) => block.content !== "");
}

test("save then load round-trips snapshot fields", () => {
  const storage = createMemoryStorage();
  const input = Object.freeze(
    snapshot("hello body", { version: 2 }),
  ) as BlockSnapshot;
  const before = structuredClone(input);

  saveBlockSnapshot("page-a", input, storage);
  const loaded = loadBlockSnapshot("page-a", storage);

  assert.deepEqual(input, before);
  assert.ok(loaded);
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.blocks, input.blocks);
  assert.equal(typeof loaded.lastAccessedAt, "number");
});

test("save and load keep extra fields on snapshot blocks", () => {
  const storage = createMemoryStorage();
  const input = {
    version: 1,
    blocks: [
      {
        id: "aaaaaa",
        title: "Notes",
        language: "markdown",
        content: "body",
        height: 240,
      },
    ],
  } as BlockSnapshot;

  saveBlockSnapshot("page-a", input, storage);
  const loaded = loadBlockSnapshot("page-a", storage);
  assert.ok(loaded);
  assert.equal((loaded.blocks[0] as { height?: number }).height, 240);
});

test("load returns undefined for corrupt snapshot JSON", () => {
  const storage = createMemoryStorage({
    [`${PREFIX}page-a`]: "{not json",
  });
  assert.equal(loadBlockSnapshot("page-a", storage), undefined);
});

test("load returns undefined for structurally invalid snapshots", () => {
  const storage = createMemoryStorage({
    [`${PREFIX}null`]: "null",
    [`${PREFIX}array`]: "[]",
    [`${PREFIX}missing-blocks`]: JSON.stringify({ version: 1 }),
  });
  assert.equal(loadBlockSnapshot("null", storage), undefined);
  assert.equal(loadBlockSnapshot("array", storage), undefined);
  assert.equal(loadBlockSnapshot("missing-blocks", storage), undefined);
});

test("load does not throw when getItem throws", () => {
  const inner = createMemoryStorage();
  const storage = withSetItem(inner, inner.setItem.bind(inner));
  storage.getItem = () => {
    throw new Error("read failed");
  };
  assert.equal(loadBlockSnapshot("page-a", storage), undefined);
});

test("legacy snapshots without lastAccessedAt still load", () => {
  const storage = createMemoryStorage();
  seedPage(storage, "page-a", "legacy body");
  const loaded = loadBlockSnapshot("page-a", storage);
  assert.ok(loaded);
  assert.equal(loaded.lastAccessedAt, undefined);
  assert.deepEqual(loaded.blocks, snapshot("legacy body").blocks);
});

test("save does not throw when setItem reports quota exceeded", () => {
  const inner = createMemoryStorage();
  const storage = withSetItem(inner, () => {
    throw quotaError();
  });
  assert.doesNotThrow(() => {
    saveBlockSnapshot("page-a", snapshot("body"), storage);
  });
});

test("save does not throw on non-quota write errors and does not evict", () => {
  const inner = createMemoryStorage();
  seedPage(inner, "page-b", "other", 10);
  inner.setItem("documentTitle:page:page-b", "Title");
  const storage = withSetItem(inner, () => {
    throw new Error("disk failed");
  });
  assert.doesNotThrow(() => {
    saveBlockSnapshot("page-a", snapshot("body"), storage);
  });
  assert.equal(inner.getItem(`${PREFIX}page-b`) !== null, true);
  assert.equal(inner.getItem("documentTitle:page:page-b"), "Title");
  assert.deepEqual(inner.removed, []);
});

test("quota overflow evicts older pages, not the current page or unrelated keys", () => {
  const inner = createMemoryStorage();
  seedPage(inner, "page-a", "current-old", 1);
  seedPage(inner, "page-b", "other", 5);
  inner.setItem("documentTitle:page:page-b", "Title");
  inner.setItem("block-height:aaaaaa", "240");
  inner.setItem("block-collapsed:aaaaaa", "true");

  let setCount = 0;
  const storage = withSetItem(inner, (key, value) => {
    setCount += 1;
    if (setCount === 1) throw quotaError();
    inner.setItem(key, value);
  });

  saveBlockSnapshot("page-a", snapshot("fresh"), storage);

  assert.deepEqual(inner.removed, [`${PREFIX}page-b`]);
  assert.equal(inner.getItem("documentTitle:page:page-b"), "Title");
  assert.equal(inner.getItem("block-height:aaaaaa"), "240");
  assert.equal(inner.getItem("block-collapsed:aaaaaa"), "true");
  assert.equal(readRaw(inner, "page-a").blocks[0].content, "fresh");
});

test("after evicting an older snapshot, save retries and stores the full body", () => {
  const inner = createMemoryStorage();
  seedPage(inner, "page-b", "other", 5);
  const writes: string[] = [];
  let setCount = 0;
  const storage = withSetItem(inner, (key, value) => {
    setCount += 1;
    writes.push(value);
    if (setCount === 1) throw quotaError();
    inner.setItem(key, value);
  });

  saveBlockSnapshot("page-a", snapshot("kept body"), storage);

  assert.equal(setCount, 2);
  assert.equal(inner.removed.length, 1);
  assert.equal(hasBlockBody(writes[1]), true);
  const loaded = loadBlockSnapshot("page-a", storage);
  assert.ok(loaded);
  assert.equal(loaded.blocks[0].content, "kept body");
});

test("when retry still exceeds quota, save stores metadata without content", () => {
  const inner = createMemoryStorage();
  seedPage(inner, "page-b", "other", 5);
  const writes: string[] = [];
  const storage = withSetItem(inner, (key, value) => {
    writes.push(value);
    if (hasBlockBody(value)) throw quotaError();
    inner.setItem(key, value);
  });

  saveBlockSnapshot("page-a", snapshot("too big"), storage);

  assert.ok(writes.length >= 3);
  assert.equal(inner.removed.length, 1);
  const loaded = loadBlockSnapshot("page-a", storage);
  assert.ok(loaded);
  assert.equal(loaded.blocks[0].id, "aaaaaa");
  assert.equal(loaded.blocks[0].title, "Notes");
  assert.equal(loaded.blocks[0].language, "markdown");
  assert.equal(loaded.blocks[0].content, "");
  assert.equal(hasBlockBody(writes[writes.length - 1]), false);
});

test("snapshots without lastAccessedAt sort as oldest during eviction", () => {
  const inner = createMemoryStorage();
  seedPage(inner, "legacy", "old-body");
  seedPage(inner, "newer", "new-body", 50);

  let setCount = 0;
  const storage = withSetItem(inner, (key, value) => {
    setCount += 1;
    if (setCount === 1) throw quotaError();
    inner.setItem(key, value);
  });

  saveBlockSnapshot("page-a", snapshot("fresh"), storage);

  assert.deepEqual(inner.removed, [`${PREFIX}legacy`]);
  assert.equal(inner.getItem(`${PREFIX}newer`) !== null, true);
});

test("metadata degrade removes the current key if overwrite still exceeds quota", () => {
  const inner = createMemoryStorage();
  seedPage(inner, "page-a", "huge-current-body", 20);
  seedPage(inner, "page-b", "other", 5);
  const storage = withSetItem(inner, (key, value) => {
    if (hasBlockBody(value)) throw quotaError();
    const existing = inner.getItem(key);
    if (existing && hasBlockBody(existing)) throw quotaError();
    inner.setItem(key, value);
  });

  saveBlockSnapshot("page-a", snapshot("too big"), storage);

  assert.ok(inner.removed.includes(`${PREFIX}page-b`));
  assert.ok(inner.removed.includes(`${PREFIX}page-a`));
  const loaded = loadBlockSnapshot("page-a", storage);
  assert.ok(loaded);
  assert.equal(loaded.blocks[0].id, "aaaaaa");
  assert.equal(loaded.blocks[0].content, "");
});
