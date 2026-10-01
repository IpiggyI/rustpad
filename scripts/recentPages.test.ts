import assert from "node:assert/strict";
import { test } from "node:test";

import { pageIdFromOpenInput } from "../src/pageOpenInput.ts";
import {
  RECENT_PAGES_STORAGE_KEY,
  type RecentPagesStorage,
  loadRecentPages,
  recordRecentPage,
  removeRecentPage,
  updateRecentPageTitle,
} from "../src/recentPages.ts";

function createMemoryStorage(
  initial: Record<string, string> = {},
): RecentPagesStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

test("write then read, under one key that is not a block snapshot", () => {
  const storage = createMemoryStorage();
  recordRecentPage("abc123", 1000, storage);
  recordRecentPage("bbbbbb", 2000, storage);
  assert.deepEqual(loadRecentPages(storage), [
    { id: "bbbbbb", title: "", openedAt: 2000 },
    { id: "abc123", title: "", openedAt: 1000 },
  ]);
  assert.equal(storage.data.size, 1);
  assert.equal(storage.data.has(RECENT_PAGES_STORAGE_KEY), true);
  assert.equal(
    RECENT_PAGES_STORAGE_KEY.startsWith("block-workspace:snapshot:"),
    false,
  );
  assert.equal(RECENT_PAGES_STORAGE_KEY.includes("abc123"), false);
});

test("reopening a page updates its time without duplicating it", () => {
  const storage = createMemoryStorage();
  recordRecentPage("abc123", 1000, storage);
  updateRecentPageTitle("abc123", "Notes", storage);
  recordRecentPage("abc123", 2500, storage);
  assert.deepEqual(loadRecentPages(storage), [
    { id: "abc123", title: "Notes", openedAt: 2500 },
  ]);
});

test("entries are newest first", () => {
  const storage = createMemoryStorage();
  recordRecentPage("aaaaaa", 1000, storage);
  recordRecentPage("bbbbbb", 3000, storage);
  recordRecentPage("cccccc", 2000, storage);
  assert.deepEqual(
    loadRecentPages(storage).map((entry) => entry.id),
    ["bbbbbb", "cccccc", "aaaaaa"],
  );
});

test("removing one entry keeps the others", () => {
  const storage = createMemoryStorage();
  recordRecentPage("aaaaaa", 1000, storage);
  recordRecentPage("bbbbbb", 3000, storage);
  recordRecentPage("cccccc", 2000, storage);
  removeRecentPage("bbbbbb", storage);
  assert.deepEqual(
    loadRecentPages(storage).map((entry) => entry.id),
    ["cccccc", "aaaaaa"],
  );
});

test("title update changes the title and keeps the opened time", () => {
  const storage = createMemoryStorage();
  recordRecentPage("abc123", 1000, storage);
  updateRecentPageTitle("abc123", "Quarterly notes", storage);
  assert.deepEqual(loadRecentPages(storage), [
    { id: "abc123", title: "Quarterly notes", openedAt: 1000 },
  ]);
  updateRecentPageTitle("missing", "Nope", storage);
  assert.equal(loadRecentPages(storage).length, 1);
});

test("corrupt or unreadable stored data yields an empty list", () => {
  const storage = createMemoryStorage();
  const corrupt = [
    "{",
    "null",
    '"x"',
    "{}",
    "[{}]",
    '[{"id":"abc123"}]',
    '[{"id":"abc123","title":1,"openedAt":1}]',
  ];
  for (const raw of corrupt) {
    storage.setItem(RECENT_PAGES_STORAGE_KEY, raw);
    assert.deepEqual(loadRecentPages(storage), []);
  }
  storage.setItem(
    RECENT_PAGES_STORAGE_KEY,
    JSON.stringify([
      { id: "abc123", title: "Notes", openedAt: 5, extra: true },
    ]),
  );
  assert.deepEqual(loadRecentPages(storage), [
    { id: "abc123", title: "Notes", openedAt: 5 },
  ]);

  const unreadable: RecentPagesStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  assert.deepEqual(loadRecentPages(unreadable), []);
  assert.doesNotThrow(() => recordRecentPage("abc123", 1, unreadable));
  assert.doesNotThrow(() => updateRecentPageTitle("abc123", "T", unreadable));
  assert.doesNotThrow(() => removeRecentPage("abc123", unreadable));
});

test("open input accepts a page id or a #page: link, and nothing else", () => {
  assert.equal(pageIdFromOpenInput("abc123"), "abc123");
  assert.equal(pageIdFromOpenInput("  Ab3xYz "), "Ab3xYz");
  assert.equal(
    pageIdFromOpenInput("http://192.168.2.100:5173/#page:abc123"),
    "abc123",
  );
  assert.equal(pageIdFromOpenInput("#page:my-page"), "my-page");
  assert.equal(pageIdFromOpenInput(""), null);
  assert.equal(pageIdFromOpenInput("   "), null);
  assert.equal(pageIdFromOpenInput("not a page"), null);
  assert.equal(pageIdFromOpenInput("http://127.0.0.1:5173/"), null);
  assert.equal(pageIdFromOpenInput("http://127.0.0.1:5173/#abc123"), null);
  assert.equal(pageIdFromOpenInput("#folds:abc123"), null);
  assert.equal(pageIdFromOpenInput("page:abc123"), null);
});
