import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldPersistSingleDocFolds } from "../src/manifestOps.ts";
import {
  type FoldStorage,
  applyFoldSidecarText,
  flushFoldMementoOnUnmount,
  foldMementoForFlush,
  foldsSidecarId,
  loadAllLocalFolds,
  loadSingleDocFolds,
  mergeFoldLanguage,
  parseFoldMap,
  persistSingleDocFolds,
  saveSingleDocFolds,
  serializeFoldMap,
  singleDocFoldsKey,
  singleDocFoldsLegacyKey,
  subscribeFoldPersistFlush,
  writeFoldMapToCache,
} from "../src/singleDocFolds.ts";

const sampleFolds = [
  {
    startLineNumber: 1,
    endLineNumber: 4,
    isCollapsed: true,
    checksum: 42,
  },
];

const jsonFolds = [
  {
    startLineNumber: 2,
    endLineNumber: 8,
    isCollapsed: true,
    checksum: 7,
  },
];

const xmlFolds = [
  {
    startLineNumber: 3,
    endLineNumber: 12,
    isCollapsed: true,
    checksum: 99,
  },
];

function createMemoryStorage(
  initial: Record<string, string> = {},
): FoldStorage & { data: Map<string, string>; writes: string[] } {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    data,
    writes,
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
      writes.push(key);
      data.set(key, value);
    },
  };
}

function persist(
  id: string,
  language: string,
  next: unknown,
  saved: unknown,
  restoring: boolean,
  storage: FoldStorage,
): unknown {
  return persistSingleDocFolds(
    id,
    language,
    next,
    saved,
    shouldPersistSingleDocFolds(next, saved, restoring),
    storage,
  );
}

test("storage key includes document id and language", () => {
  assert.equal(
    singleDocFoldsKey("doc-a", "markdown"),
    "single-doc:folds:doc-a:markdown",
  );
  assert.equal(
    singleDocFoldsKey("doc-a", "json"),
    "single-doc:folds:doc-a:json",
  );
  assert.equal(singleDocFoldsKey("doc-a", "xml"), "single-doc:folds:doc-a:xml");
  assert.equal(singleDocFoldsLegacyKey("doc-a"), "single-doc:folds:doc-a");
});

test("saveSingleDocFolds does not store undefined as []", () => {
  const storage = createMemoryStorage();
  saveSingleDocFolds("doc-a", "json", undefined, storage);
  assert.equal(storage.getItem("single-doc:folds:doc-a:json"), null);
  assert.equal(storage.writes.length, 0);
});

test("shouldPersist is false while composing", () => {
  assert.equal(
    shouldPersistSingleDocFolds(sampleFolds, undefined, false, true),
    false,
  );
});

test("save then load round-trips a fold memento at single-doc:folds:${id}:${language}", () => {
  const storage = createMemoryStorage();
  const input = structuredClone(sampleFolds);
  saveSingleDocFolds("doc-a", "markdown", input, storage);
  assert.equal(
    storage.getItem("single-doc:folds:doc-a:markdown"),
    JSON.stringify(sampleFolds),
  );
  assert.equal(storage.getItem("single-doc:folds:doc-a"), null);
  assert.deepEqual(
    loadSingleDocFolds("doc-a", "markdown", storage),
    sampleFolds,
  );
  assert.deepEqual(input, sampleFolds);
});

test("json, xml, and markdown fold records are isolated by language key", () => {
  const storage = createMemoryStorage();
  saveSingleDocFolds("doc-a", "markdown", sampleFolds, storage);
  saveSingleDocFolds("doc-a", "json", jsonFolds, storage);
  saveSingleDocFolds("doc-a", "xml", xmlFolds, storage);
  assert.deepEqual(
    loadSingleDocFolds("doc-a", "markdown", storage),
    sampleFolds,
  );
  assert.deepEqual(loadSingleDocFolds("doc-a", "json", storage), jsonFolds);
  assert.deepEqual(loadSingleDocFolds("doc-a", "xml", storage), xmlFolds);
  assert.equal(storage.getItem("single-doc:folds:doc-a"), null);
  assert.notEqual(
    storage.getItem("single-doc:folds:doc-a:json"),
    storage.getItem("single-doc:folds:doc-a:markdown"),
  );
});

test("save and load keep separate records per document id", () => {
  const storage = createMemoryStorage();
  saveSingleDocFolds("doc-a", "json", sampleFolds, storage);
  saveSingleDocFolds("doc-b", "json", jsonFolds, storage);
  assert.deepEqual(loadSingleDocFolds("doc-a", "json", storage), sampleFolds);
  assert.deepEqual(loadSingleDocFolds("doc-b", "json", storage), jsonFolds);
});

test("legacy key is read only as markdown when the language-specific key is missing", () => {
  const storage = createMemoryStorage({
    "single-doc:folds:doc-a": JSON.stringify(sampleFolds),
  });
  assert.deepEqual(
    loadSingleDocFolds("doc-a", "markdown", storage),
    sampleFolds,
  );
  assert.equal(loadSingleDocFolds("doc-a", "json", storage), undefined);
  assert.equal(loadSingleDocFolds("doc-a", "xml", storage), undefined);
});

test("language-specific markdown key wins over the legacy key", () => {
  const storage = createMemoryStorage({
    "single-doc:folds:doc-a": JSON.stringify(sampleFolds),
    "single-doc:folds:doc-a:markdown": JSON.stringify(jsonFolds),
  });
  assert.deepEqual(loadSingleDocFolds("doc-a", "markdown", storage), jsonFolds);
});

test("persist of json does not write the markdown or legacy key", () => {
  const storage = createMemoryStorage();
  persist("doc-a", "json", jsonFolds, undefined, false, storage);
  assert.equal(storage.getItem("single-doc:folds:doc-a"), null);
  assert.equal(storage.getItem("single-doc:folds:doc-a:markdown"), null);
  assert.equal(
    storage.getItem("single-doc:folds:doc-a:json"),
    JSON.stringify(jsonFolds),
  );
  assert.deepEqual(loadSingleDocFolds("doc-a", "json", storage), jsonFolds);
});

test("load returns undefined when no record is stored", () => {
  const storage = createMemoryStorage();
  assert.equal(loadSingleDocFolds("missing", "json", storage), undefined);
});

test("load returns undefined for corrupt JSON", () => {
  const storage = createMemoryStorage({
    "single-doc:folds:doc-a:json": "{not json",
  });
  assert.equal(loadSingleDocFolds("doc-a", "json", storage), undefined);
});

test("load does not throw when getItem throws", () => {
  const storage = createMemoryStorage();
  storage.getItem = () => {
    throw new Error("read failed");
  };
  assert.equal(loadSingleDocFolds("doc-a", "xml", storage), undefined);
});

test("save does not throw when setItem fails", () => {
  const storage = createMemoryStorage();
  storage.setItem = () => {
    throw new Error("quota");
  };
  assert.doesNotThrow(() => {
    saveSingleDocFolds("doc-a", "json", jsonFolds, storage);
  });
});

test("a cleared folding-model read persists after restore", () => {
  assert.equal(shouldPersistSingleDocFolds([], sampleFolds, false), true);
});

test("an unreadable memento must not wipe a saved record", () => {
  assert.equal(
    shouldPersistSingleDocFolds(undefined, sampleFolds, false),
    false,
  );
});

test("shouldPersist is false while restore is in progress", () => {
  assert.equal(shouldPersistSingleDocFolds([], sampleFolds, true), false);
  assert.equal(
    shouldPersistSingleDocFolds(sampleFolds, undefined, true),
    false,
  );
  assert.equal(
    shouldPersistSingleDocFolds(sampleFolds, sampleFolds, true),
    false,
  );
});

test("persist of a cleared record writes an empty array for json and xml", () => {
  for (const language of ["json", "xml", "markdown"]) {
    const storage = createMemoryStorage();
    saveSingleDocFolds("doc-a", language, sampleFolds, storage);
    const kept = persist("doc-a", language, [], sampleFolds, false, storage);
    assert.deepEqual(kept, []);
    assert.deepEqual(loadSingleDocFolds("doc-a", language, storage), []);
  }
});

test("persist of an unreadable memento leaves a saved record in storage", () => {
  const storage = createMemoryStorage();
  saveSingleDocFolds("doc-a", "json", jsonFolds, storage);
  const kept = persist("doc-a", "json", undefined, jsonFolds, false, storage);
  assert.deepEqual(kept, jsonFolds);
  assert.deepEqual(loadSingleDocFolds("doc-a", "json", storage), jsonFolds);
});

test("persist during restore leaves a saved record in storage", () => {
  const storage = createMemoryStorage();
  saveSingleDocFolds("doc-a", "xml", xmlFolds, storage);
  const kept = persist("doc-a", "xml", [], xmlFolds, true, storage);
  assert.deepEqual(kept, xmlFolds);
  assert.deepEqual(loadSingleDocFolds("doc-a", "xml", storage), xmlFolds);
});

test("flush uses a live memento when the model language matches the session", () => {
  assert.deepEqual(
    foldMementoForFlush("markdown", "markdown", [], sampleFolds),
    [],
  );
  assert.deepEqual(foldMementoForFlush("json", "json", [], jsonFolds), []);
  assert.deepEqual(
    foldMementoForFlush("xml", "xml", xmlFolds, undefined),
    xmlFolds,
  );
});

test("language-change flush keeps the session memento, not the new language", () => {
  assert.deepEqual(
    foldMementoForFlush("json", "markdown", jsonFolds, sampleFolds),
    sampleFolds,
  );
  assert.deepEqual(
    foldMementoForFlush("xml", "json", xmlFolds, jsonFolds),
    jsonFolds,
  );
  assert.deepEqual(
    foldMementoForFlush("markdown", "xml", sampleFolds, xmlFolds),
    xmlFolds,
  );
});

test("flush falls back to the last session memento when the live read is unreadable", () => {
  assert.deepEqual(
    foldMementoForFlush("json", "json", undefined, jsonFolds),
    jsonFolds,
  );
  assert.equal(
    foldMementoForFlush(undefined, "xml", xmlFolds, jsonFolds),
    jsonFolds,
  );
});

test("unread flush keeps saved; a real clear flush is []", () => {
  assert.deepEqual(
    foldMementoForFlush("markdown", "markdown", undefined, sampleFolds),
    sampleFolds,
  );
  assert.deepEqual(
    foldMementoForFlush("markdown", "markdown", [], sampleFolds),
    [],
  );
});

test("page hide flushes even if the debounce has not fired", () => {
  let flushes = 0;
  const listeners = new Map();
  const target = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const stop = subscribeFoldPersistFlush(() => flushes++, target, null);
  listeners.get("pagehide")();
  listeners.get("beforeunload")();
  assert.equal(flushes, 2);
  stop();
  assert.equal(listeners.size, 0);
});

test("block-style unmount: debounce cancelled, last-good still flushed", () => {
  let cancelled = false;
  let debouncedWrite = false;
  const persist = {
    cancel() {
      cancelled = true;
    },
    flush() {
      if (!cancelled) debouncedWrite = true;
    },
  };
  const next = flushFoldMementoOnUnmount(
    persist,
    "markdown",
    "markdown",
    undefined,
    sampleFolds,
  );
  persist.flush();
  assert.equal(cancelled, true);
  assert.equal(debouncedWrite, false);
  assert.deepEqual(next, sampleFolds);
  assert.equal(shouldPersistSingleDocFolds(next, undefined, false), true);
});

test("persist writes only when the fold record differs", () => {
  const storage = createMemoryStorage();
  const first = persist("doc-a", "json", jsonFolds, undefined, false, storage);
  assert.deepEqual(first, jsonFolds);
  assert.equal(storage.writes.length, 1);
  persist("doc-a", "json", structuredClone(jsonFolds), first, false, storage);
  assert.equal(storage.writes.length, 1);
  const next = persist("doc-a", "json", xmlFolds, first, false, storage);
  assert.deepEqual(next, xmlFolds);
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(loadSingleDocFolds("doc-a", "json", storage), xmlFolds);
});

test("sidecar id is folds:${id}", () => {
  assert.equal(foldsSidecarId("abc123"), "folds:abc123");
});

test("serializeFoldMap sorts language keys for min-diff OT", () => {
  const text = serializeFoldMap({
    xml: xmlFolds,
    markdown: sampleFolds,
    json: jsonFolds,
  });
  assert.equal(
    text,
    JSON.stringify({
      json: jsonFolds,
      markdown: sampleFolds,
      xml: xmlFolds,
    }),
  );
  assert.equal(text.startsWith("{"), true);
  assert.equal(text.includes("single-doc:folds:"), false);
});

test("parseFoldMap recovers the first JSON object from concatenated values", () => {
  const first = { json: jsonFolds };
  const text =
    JSON.stringify(first) + JSON.stringify({ markdown: sampleFolds });
  assert.deepEqual(parseFoldMap(text), first);
});

test("parseFoldMap returns null for empty, array, or illegal JSON", () => {
  assert.equal(parseFoldMap(""), null);
  assert.equal(parseFoldMap("[]"), null);
  assert.equal(parseFoldMap("{not json"), null);
});

test("loadAllLocalFolds seeds every language plus the markdown legacy key", () => {
  const storage = createMemoryStorage({
    "single-doc:folds:doc-a:json": JSON.stringify(jsonFolds),
    "single-doc:folds:doc-a:xml": JSON.stringify(xmlFolds),
    "single-doc:folds:doc-a": JSON.stringify(sampleFolds),
    "single-doc:folds:doc-b:json": JSON.stringify(xmlFolds),
    "documentTitle:doc-a": "Notes",
  });
  const map = loadAllLocalFolds("doc-a", storage);
  assert.deepEqual(map, {
    json: jsonFolds,
    xml: xmlFolds,
    markdown: sampleFolds,
  });
});

test("loadAllLocalFolds prefers the language-specific markdown key over legacy", () => {
  const storage = createMemoryStorage({
    "single-doc:folds:doc-a": JSON.stringify(sampleFolds),
    "single-doc:folds:doc-a:markdown": JSON.stringify(jsonFolds),
  });
  assert.deepEqual(loadAllLocalFolds("doc-a", storage), {
    markdown: jsonFolds,
  });
});

test("mergeFoldLanguage keeps other languages when writing the current one", () => {
  const merged = mergeFoldLanguage(
    { markdown: sampleFolds, json: jsonFolds },
    "xml",
    xmlFolds,
  );
  assert.deepEqual(merged.markdown, sampleFolds);
  assert.deepEqual(merged.json, jsonFolds);
  assert.deepEqual(merged.xml, xmlFolds);
  const cleared = mergeFoldLanguage(merged, "json", []);
  assert.deepEqual(cleared.json, []);
  assert.deepEqual(cleared.markdown, sampleFolds);
});

test("empty sidecar seeds once from all local languages", () => {
  const local = { markdown: sampleFolds, json: jsonFolds };
  const first = applyFoldSidecarText(
    "",
    { initialized: false, lastValid: {} },
    local,
  );
  assert.equal(first.state.initialized, true);
  assert.deepEqual(first.state.lastValid, local);
  assert.equal(first.writeText, serializeFoldMap(local));
  const second = applyFoldSidecarText("", first.state, { xml: xmlFolds });
  assert.equal(second.writeText, serializeFoldMap(local));
  assert.deepEqual(second.state.lastValid, local);
});

test("non-empty sidecar wins and is never overwritten by local cache", () => {
  const server = { json: jsonFolds };
  const first = applyFoldSidecarText(
    serializeFoldMap(server),
    { initialized: false, lastValid: {} },
    { markdown: sampleFolds, xml: xmlFolds },
  );
  assert.equal(first.writeText, undefined);
  assert.deepEqual(first.state.lastValid, server);
  const second = applyFoldSidecarText("", first.state, {
    markdown: sampleFolds,
    xml: xmlFolds,
  });
  assert.equal(second.writeText, serializeFoldMap(server));
  assert.deepEqual(second.state.lastValid, server);
});

test("after init, unparseable sidecar text is rewritten from lastValid not local seed", () => {
  const server = { markdown: sampleFolds };
  const ready = applyFoldSidecarText(
    serializeFoldMap(server),
    { initialized: false, lastValid: {} },
    {},
  );
  const healed = applyFoldSidecarText("{not json", ready.state, {
    json: jsonFolds,
  });
  assert.equal(healed.writeText, serializeFoldMap(server));
  assert.deepEqual(healed.state.lastValid, server);
});

test("concatenated sidecar JSON is canonicalized after init", () => {
  const firstObj = { xml: xmlFolds, json: jsonFolds };
  const concat =
    JSON.stringify(firstObj) + JSON.stringify({ markdown: sampleFolds });
  const ready = applyFoldSidecarText(
    concat,
    { initialized: false, lastValid: {} },
    {},
  );
  assert.deepEqual(ready.state.lastValid, firstObj);
  const healed = applyFoldSidecarText(concat, ready.state, {});
  assert.equal(healed.writeText, serializeFoldMap(firstObj));
});

test("writeFoldMapToCache writes sidecar languages to local cache keys", () => {
  const storage = createMemoryStorage();
  writeFoldMapToCache(
    "doc-a",
    { json: jsonFolds, markdown: sampleFolds },
    storage,
  );
  assert.deepEqual(loadSingleDocFolds("doc-a", "json", storage), jsonFolds);
  assert.deepEqual(
    loadSingleDocFolds("doc-a", "markdown", storage),
    sampleFolds,
  );
});
