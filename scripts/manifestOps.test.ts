import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BlockInfo,
  type Manifest,
  addBlock,
  doesFoldRecordDiffer,
  isEmptyFoldRecord,
  migrateCompactHeights,
  migrateLegacyLayout,
  moveBlock,
  moveBlockBefore,
  parseManifest,
  removeBlock,
  sanitizeManifest,
  serializeManifest,
  updateBlock,
  updateBlockLayout,
} from "../src/manifestOps.ts";

function block(
  id: string,
  title: string = id,
  language: string = "plaintext",
): BlockInfo {
  return { id, title, language };
}

function manifest(blocks: BlockInfo[], title: string = "page"): Manifest {
  return { version: 1, title, blocks };
}

function freezeManifest(value: Manifest): Manifest {
  for (const entry of value.blocks) {
    Object.freeze(entry);
  }
  Object.freeze(value.blocks);
  return Object.freeze(value);
}

function prepared(blocks: BlockInfo[], title: string = "page"): Manifest {
  return freezeManifest(structuredClone(manifest(blocks, title)));
}

function assertUntouched(input: Manifest, before: Manifest) {
  assert.deepEqual(input, before);
}

function assertNoChange(result: Manifest, input: Manifest, before: Manifest) {
  assert.deepEqual(result, input);
  assertUntouched(input, before);
}

function withoutBlock(value: Manifest, blockId: string): Manifest {
  return {
    ...value,
    blocks: value.blocks.filter((block) => block.id !== blockId),
  };
}

const a = block("aaaaaa", "A", "markdown");
const b = block("bbbbbb", "B", "python");
const c = block("cccccc", "C", "rust");
const d = block("dddddd", "D", "javascript");

test("moveBlock up swaps the target with the previous block", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = moveBlock(input, "bbbbbb", "up");
  assert.deepEqual(result.blocks, [b, a, c]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("moveBlock down swaps the target with the next block", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = moveBlock(input, "bbbbbb", "down");
  assert.deepEqual(result.blocks, [a, c, b]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("moveBlock top moves the target to the front and keeps the rest in order", () => {
  const input = prepared([a, b, c, d]);
  const before = structuredClone(input);
  const result = moveBlock(input, "cccccc", "top");
  assert.deepEqual(result.blocks, [c, a, b, d]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("moveBlock bottom moves the target to the end and keeps the rest in order", () => {
  const input = prepared([a, b, c, d]);
  const before = structuredClone(input);
  const result = moveBlock(input, "bbbbbb", "bottom");
  assert.deepEqual(result.blocks, [a, c, d, b]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("moveBlock up on the first block returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "aaaaaa", "up"), input, before);
});

test("moveBlock top on the first block returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "aaaaaa", "top"), input, before);
});

test("moveBlock down on the last block returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "cccccc", "down"), input, before);
});

test("moveBlock bottom on the last block returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "cccccc", "bottom"), input, before);
});

test("moveBlock on a single-block manifest returns an equivalent manifest", () => {
  const input = prepared([a]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "aaaaaa", "up"), input, before);
  assertNoChange(moveBlock(input, "aaaaaa", "down"), input, before);
  assertNoChange(moveBlock(input, "aaaaaa", "top"), input, before);
  assertNoChange(moveBlock(input, "aaaaaa", "bottom"), input, before);
});

test("moveBlock on an empty manifest returns an equivalent manifest", () => {
  const input = prepared([]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "aaaaaa", "up"), input, before);
  assertNoChange(moveBlock(input, "aaaaaa", "down"), input, before);
  assertNoChange(moveBlock(input, "aaaaaa", "top"), input, before);
  assertNoChange(moveBlock(input, "aaaaaa", "bottom"), input, before);
});

test("moveBlock with a missing id returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "nope00", "up"), input, before);
  assertNoChange(moveBlock(input, "nope00", "down"), input, before);
  assertNoChange(moveBlock(input, "nope00", "top"), input, before);
  assertNoChange(moveBlock(input, "nope00", "bottom"), input, before);
});

test("moveBlockBefore inserts the target immediately before the reference block", () => {
  const input = prepared([a, b, c, d]);
  const before = structuredClone(input);
  const result = moveBlockBefore(input, "dddddd", "bbbbbb");
  assert.deepEqual(result.blocks, [a, d, b, c]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("moveBlockBefore moving a later block forward keeps the rest in order", () => {
  const input = prepared([a, b, c, d]);
  const before = structuredClone(input);
  const result = moveBlockBefore(input, "cccccc", "aaaaaa");
  assert.deepEqual(result.blocks, [c, a, b, d]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("moveBlockBefore with a null reference appends the target at the end", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = moveBlockBefore(input, "aaaaaa", null);
  assert.deepEqual(result.blocks, [b, c, a]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("moveBlockBefore relocates the target by id and keeps a block another client added", () => {
  const extra = block("eeeeee", "E", "go");
  const input = prepared([a, extra, b, c]);
  const before = structuredClone(input);
  const result = moveBlockBefore(input, "cccccc", "aaaaaa");
  assert.deepEqual(result.blocks, [c, a, extra, b]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("moveBlockBefore returns the original manifest when the target is already in place", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = moveBlockBefore(input, "aaaaaa", "bbbbbb");
  assert.equal(result, input);
  assertNoChange(result, input, before);
});

test("moveBlockBefore returns the original manifest when appending a block that is already last", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = moveBlockBefore(input, "cccccc", null);
  assert.equal(result, input);
  assertNoChange(result, input, before);
});

test("moveBlockBefore returns the original manifest when the dragged id is no longer in the manifest", () => {
  const input = prepared([a, c]);
  const before = structuredClone(input);
  const result = moveBlockBefore(input, "bbbbbb", "aaaaaa");
  assert.equal(result, input);
  assertNoChange(result, input, before);
});

test("moveBlockBefore returns the original manifest when the reference id is no longer in the manifest", () => {
  const input = prepared([a, c]);
  const before = structuredClone(input);
  const result = moveBlockBefore(input, "aaaaaa", "bbbbbb");
  assert.equal(result, input);
  assertNoChange(result, input, before);
});

test("addBlock prepends an Untitled block and keeps the rest in order", () => {
  const input = prepared([a, b, c], "workspace");
  const before = structuredClone(input);
  const result = addBlock(input, "javascript");
  assert.equal(result.blocks.length, 4);
  assert.equal(result.blocks[0].title, "Untitled");
  assert.equal(result.blocks[0].language, "javascript");
  assert.equal(/^[a-z0-9]{6}$/.test(result.blocks[0].id), true);
  assert.deepEqual(result.blocks.slice(1), [a, b, c]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "workspace");
  assertUntouched(input, before);
});

test("addBlock with position start prepends and keeps the rest in order", () => {
  const input = prepared([a, b, c], "workspace");
  const before = structuredClone(input);
  const result = addBlock(input, "javascript", "start");
  assert.equal(result.blocks.length, 4);
  assert.equal(result.blocks[0].title, "Untitled");
  assert.equal(result.blocks[0].language, "javascript");
  assert.equal(/^[a-z0-9]{6}$/.test(result.blocks[0].id), true);
  assert.deepEqual(result.blocks.slice(1), [a, b, c]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "workspace");
  assertUntouched(input, before);
});

test("addBlock with position end appends and keeps the rest in order", () => {
  const input = prepared([a, b, c], "workspace");
  const before = structuredClone(input);
  const result = addBlock(input, "javascript", "end");
  assert.equal(result.blocks.length, 4);
  const added = result.blocks[result.blocks.length - 1];
  assert.equal(added.title, "Untitled");
  assert.equal(added.language, "javascript");
  assert.equal(/^[a-z0-9]{6}$/.test(added.id), true);
  assert.deepEqual(result.blocks.slice(0, -1), [a, b, c]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "workspace");
  assertUntouched(input, before);
});

test("addBlock defaults language to plaintext", () => {
  const input = prepared([a]);
  const before = structuredClone(input);
  const result = addBlock(input);
  assert.equal(result.blocks[0].language, "plaintext");
  assert.equal(result.blocks[0].title, "Untitled");
  assert.deepEqual(result.blocks.slice(1), [a]);
  assertUntouched(input, before);
});

test("removeBlock drops only the target block", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = removeBlock(input, "bbbbbb");
  assert.deepEqual(result.blocks, [a, c]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("removeBlock with a missing id returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(removeBlock(input, "nope00"), input, before);
});

test("removeBlock on an empty manifest returns an equivalent manifest", () => {
  const input = prepared([]);
  const before = structuredClone(input);
  assertNoChange(removeBlock(input, "aaaaaa"), input, before);
});

test("updateBlock patches title and language of the target only", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = updateBlock(input, "bbbbbb", {
    title: "Renamed",
    language: "go",
  });
  assert.deepEqual(result.blocks, [
    a,
    { id: "bbbbbb", title: "Renamed", language: "go" },
    c,
  ]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("updateBlock with a missing id returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(updateBlock(input, "nope00", { title: "X" }), input, before);
});

test("updateBlock on an empty manifest returns an equivalent manifest", () => {
  const input = prepared([]);
  const before = structuredClone(input);
  assertNoChange(updateBlock(input, "aaaaaa", { title: "X" }), input, before);
});

test("parseManifest reads a well-formed manifest", () => {
  const text = JSON.stringify({
    version: 1,
    title: "Workspace",
    blocks: [{ id: "abc123", title: "Intro", language: "markdown" }],
  });
  assert.deepEqual(parseManifest(text), {
    version: 1,
    title: "Workspace",
    blocks: [{ id: "abc123", title: "Intro", language: "markdown" }],
  });
});

test("parseManifest returns null for empty text", () => {
  assert.equal(parseManifest(""), null);
  assert.equal(parseManifest("   \n\t"), null);
});

test("parseManifest returns null for illegal JSON without throwing", () => {
  assert.equal(parseManifest("{"), null);
  assert.equal(parseManifest("not json"), null);
  assert.equal(parseManifest('{"blocks":'), null);
});

test("parseManifest recovers the first value from concatenated JSON", () => {
  const first = {
    version: 1,
    title: "first",
    blocks: [a],
  };
  const second = {
    version: 1,
    title: "second",
    blocks: [b],
  };
  const text = JSON.stringify(first) + JSON.stringify(second);
  assert.deepEqual(parseManifest(text), first);
});

test("parseManifest drops blocks with illegal ids and keeps surviving order", () => {
  const text = JSON.stringify({
    version: 1,
    title: "page",
    blocks: [
      a,
      { id: "ABC123", title: "bad-case", language: "plaintext" },
      { id: "short", title: "short", language: "plaintext" },
      { id: "toolong1", title: "long", language: "plaintext" },
      c,
    ],
  });
  assert.deepEqual(parseManifest(text)?.blocks, [a, c]);
  assert.equal(parseManifest(text)?.title, "page");
  assert.equal(parseManifest(text)?.version, 1);
});

test("parseManifest keeps the first block when ids repeat", () => {
  const duplicate = { id: "aaaaaa", title: "dup", language: "go" };
  const text = JSON.stringify({
    version: 1,
    title: "page",
    blocks: [a, b, duplicate, c],
  });
  assert.deepEqual(parseManifest(text)?.blocks, [a, b, c]);
});

test("parseManifest returns a legal manifest unchanged", () => {
  const value = {
    version: 1,
    title: "Workspace",
    blocks: [a, b, c],
  };
  assert.deepEqual(parseManifest(JSON.stringify(value)), value);
});

test("sanitizeManifest returns a legal manifest unchanged", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = sanitizeManifest(input);
  assert.deepEqual(result.blocks, [a, b, c]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("sanitizeManifest drops illegal and duplicate ids and keeps surviving order", () => {
  const duplicate = { id: "aaaaaa", title: "dup", language: "go" };
  const input = freezeManifest(
    structuredClone(
      manifest([
        a,
        { id: "ABC123", title: "bad-case", language: "plaintext" },
        b,
        duplicate,
        c,
      ]),
    ),
  );
  const before = structuredClone(input);
  const result = sanitizeManifest(input);
  assert.deepEqual(result.blocks, [a, b, c]);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("updateBlockLayout changes only the target block and leaves other fields byte-identical", () => {
  const extra = { ...a, height: 240, collapsed: true };
  const input = freezeManifest(
    structuredClone(manifest([extra, b, c], "workspace")),
  );
  const before = structuredClone(input);
  const result = updateBlockLayout(input, "bbbbbb", {
    height: 420,
    collapsed: true,
  });
  assert.deepEqual(result.blocks[1], {
    id: "bbbbbb",
    title: "B",
    language: "python",
    height: 420,
    collapsed: true,
  });
  assert.equal(
    JSON.stringify(withoutBlock(result, "bbbbbb")),
    JSON.stringify(withoutBlock(input, "bbbbbb")),
  );
  assert.equal(result.version, 1);
  assert.equal(result.title, "workspace");
  assertUntouched(input, before);
});

test("updateBlockLayout patches one field and keeps the other layout field", () => {
  const target = { ...b, height: 300, collapsed: true };
  const input = freezeManifest(structuredClone(manifest([a, target, c])));
  const before = structuredClone(input);
  const result = updateBlockLayout(input, "bbbbbb", { height: 420 });
  assert.equal(result.blocks[1].height, 420);
  assert.equal(result.blocks[1].collapsed, true);
  assert.deepEqual(result.blocks[0], a);
  assert.deepEqual(result.blocks[2], c);
  assertUntouched(input, before);
});

test("updateBlockLayout with a missing id returns the original manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = updateBlockLayout(input, "nope00", { height: 420 });
  assert.equal(result, input);
  assertNoChange(result, input, before);
});

test("updateBlockLayout returns the original manifest when the layout is unchanged", () => {
  const target = { ...b, height: 420, collapsed: true };
  const input = freezeManifest(structuredClone(manifest([a, target, c])));
  const before = structuredClone(input);
  const result = updateBlockLayout(input, "bbbbbb", {
    height: 420,
    collapsed: true,
  });
  assert.equal(result, input);
  assertNoChange(result, input, before);
});

test("migrateLegacyLayout adopts a legacy value only when the manifest field is missing", () => {
  const kept = { ...b, height: 500, collapsed: true };
  const heightOnly = { ...c, height: 360 };
  const input = freezeManifest(
    structuredClone(manifest([a, kept, heightOnly], "workspace")),
  );
  const before = structuredClone(input);
  const result = migrateLegacyLayout(input, {
    aaaaaa: { height: 240, collapsed: true },
    bbbbbb: { height: 111, collapsed: false },
    cccccc: { height: 999, collapsed: true },
    zzzzzz: { height: 100 },
  });
  assert.deepEqual(result.blocks[0], {
    ...a,
    height: 240,
    collapsed: true,
  });
  assert.deepEqual(result.blocks[1], kept);
  assert.deepEqual(result.blocks[2], { ...heightOnly, collapsed: true });
  assert.equal(result.version, 1);
  assert.equal(result.title, "workspace");
  assertUntouched(input, before);
});

test("migrateLegacyLayout returns the original manifest when every present field is already set", () => {
  const filled = [
    { ...a, height: 240, collapsed: false },
    { ...b, height: 500, collapsed: true },
  ];
  const input = freezeManifest(structuredClone(manifest(filled)));
  const before = structuredClone(input);
  const result = migrateLegacyLayout(input, {
    aaaaaa: { height: 1, collapsed: true },
    bbbbbb: { height: 2, collapsed: false },
  });
  assert.equal(result, input);
  assertNoChange(result, input, before);
});

const sampleFolds = [
  {
    startLineNumber: 1,
    endLineNumber: 4,
    isCollapsed: true,
    checksum: 42,
  },
];

test("isEmptyFoldRecord is true for a missing record and for an empty array", () => {
  assert.equal(isEmptyFoldRecord(undefined), true);
  assert.equal(isEmptyFoldRecord([]), true);
});

test("isEmptyFoldRecord is false for a collapsed-region record", () => {
  assert.equal(isEmptyFoldRecord(sampleFolds), false);
});

test("doesFoldRecordDiffer is false when both records are missing", () => {
  assert.equal(doesFoldRecordDiffer(undefined, undefined), false);
});

test("doesFoldRecordDiffer is false when a missing record matches an empty array", () => {
  assert.equal(doesFoldRecordDiffer(undefined, []), false);
  assert.equal(doesFoldRecordDiffer([], undefined), false);
});

test("doesFoldRecordDiffer is false for two empty arrays", () => {
  assert.equal(doesFoldRecordDiffer([], []), false);
});

test("doesFoldRecordDiffer is false when two fold records are deeply equal", () => {
  assert.equal(
    doesFoldRecordDiffer(sampleFolds, structuredClone(sampleFolds)),
    false,
  );
});

test("doesFoldRecordDiffer is false when two fold records have the same keys in different order", () => {
  const left = [
    {
      checksum: 1,
      startLineNumber: 1,
      endLineNumber: 3,
      isCollapsed: true,
    },
  ];
  const right = [
    {
      startLineNumber: 1,
      endLineNumber: 3,
      isCollapsed: true,
      checksum: 1,
    },
  ];
  assert.equal(doesFoldRecordDiffer(left, right), false);
});

test("doesFoldRecordDiffer is true when collapsed regions differ", () => {
  const other = [
    {
      startLineNumber: 2,
      endLineNumber: 8,
      isCollapsed: true,
      checksum: 42,
    },
  ];
  assert.equal(doesFoldRecordDiffer(sampleFolds, other), true);
});

test("doesFoldRecordDiffer is true when a fold record appears where none was saved", () => {
  assert.equal(doesFoldRecordDiffer(sampleFolds, undefined), true);
});

test("doesFoldRecordDiffer is true when a saved fold record is cleared", () => {
  assert.equal(doesFoldRecordDiffer(undefined, sampleFolds), true);
  assert.equal(doesFoldRecordDiffer([], sampleFolds), true);
});

test("doesFoldRecordDiffer is true when a non-array record replaces an empty record", () => {
  assert.equal(doesFoldRecordDiffer({ collapsedRegions: [] }, undefined), true);
});

test("parseManifest keeps a folds field on a block entry", () => {
  const text = JSON.stringify({
    version: 1,
    title: "Workspace",
    blocks: [
      {
        id: "abc123",
        title: "Intro",
        language: "markdown",
        folds: sampleFolds,
      },
    ],
  });
  assert.deepEqual(parseManifest(text)?.blocks[0].folds, sampleFolds);
});

test("updateBlockLayout writes folds on the target block and leaves other fields byte-identical", () => {
  const extra = { ...a, height: 240, collapsed: true };
  const input = freezeManifest(
    structuredClone(manifest([extra, b, c], "workspace")),
  );
  const before = structuredClone(input);
  const result = updateBlockLayout(input, "bbbbbb", { folds: sampleFolds });
  assert.deepEqual(result.blocks[1], {
    id: "bbbbbb",
    title: "B",
    language: "python",
    folds: sampleFolds,
  });
  assert.equal(
    JSON.stringify(withoutBlock(result, "bbbbbb")),
    JSON.stringify(withoutBlock(input, "bbbbbb")),
  );
  assert.equal(result.version, 1);
  assert.equal(result.title, "workspace");
  assertUntouched(input, before);
});

test("updateBlockLayout patches folds and keeps height and collapsed", () => {
  const target = { ...b, height: 300, collapsed: true };
  const input = freezeManifest(structuredClone(manifest([a, target, c])));
  const before = structuredClone(input);
  const result = updateBlockLayout(input, "bbbbbb", { folds: sampleFolds });
  assert.deepEqual(result.blocks[1].folds, sampleFolds);
  assert.equal(result.blocks[1].height, 300);
  assert.equal(result.blocks[1].collapsed, true);
  assert.deepEqual(result.blocks[0], a);
  assert.deepEqual(result.blocks[2], c);
  assertUntouched(input, before);
});

test("updateBlockLayout returns the original manifest when folds are equivalent", () => {
  const target = { ...b, folds: sampleFolds };
  const input = freezeManifest(structuredClone(manifest([a, target, c])));
  const before = structuredClone(input);
  const result = updateBlockLayout(input, "bbbbbb", {
    folds: structuredClone(sampleFolds),
  });
  assert.equal(result, input);
  assertNoChange(result, input, before);
});

test("updateBlockLayout returns the original manifest when incoming folds are empty and none are stored", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  const result = updateBlockLayout(input, "bbbbbb", { folds: [] });
  assert.equal(result, input);
  assertNoChange(result, input, before);
});

test("migrateCompactHeights sets missing heights to 200 and writes compactHeights", () => {
  const input = prepared([a, b]);
  const before = structuredClone(input);
  const result = migrateCompactHeights(input);
  assert.equal(result.compactHeights, true);
  assert.equal(result.blocks[0].height, 200);
  assert.equal(result.blocks[1].height, 200);
  assert.equal(result.blocks[0].id, "aaaaaa");
  assert.equal(result.blocks[0].title, "A");
  assert.equal(result.blocks[0].language, "markdown");
  assert.equal(result.blocks[1].id, "bbbbbb");
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assert.equal(result.blocks.length, 2);
  assertUntouched(input, before);
});

test("migrateCompactHeights resets mixed saved heights to 200 including collapsed blocks", () => {
  const mixed = [
    { ...a, height: 480, collapsed: true, folds: sampleFolds },
    { ...b, height: 120 },
    c,
  ];
  const input = freezeManifest(structuredClone(manifest(mixed, "workspace")));
  const before = structuredClone(input);
  const result = migrateCompactHeights(input);
  assert.equal(result.compactHeights, true);
  assert.equal(result.version, 1);
  assert.equal(result.title, "workspace");
  assert.deepEqual(result.blocks, [
    {
      ...a,
      height: 200,
      collapsed: true,
      folds: sampleFolds,
    },
    { ...b, height: 200 },
    { ...c, height: 200 },
  ]);
  assertUntouched(input, before);
});

test("migrateCompactHeights returns the same object when compactHeights is already true", () => {
  const marked = freezeManifest(
    structuredClone({
      version: 1,
      title: "page",
      compactHeights: true,
      blocks: [
        { ...a, height: 480, collapsed: true, folds: sampleFolds },
        { ...b, height: 120 },
      ],
    }),
  );
  const before = structuredClone(marked);
  const result = migrateCompactHeights(marked);
  assert.equal(result, marked);
  assert.equal(result.compactHeights, true);
  assert.equal(result.blocks[0].height, 480);
  assert.equal(result.blocks[0].collapsed, true);
  assert.deepEqual(result.blocks[0].folds, sampleFolds);
  assert.equal(result.blocks[1].height, 120);
  assertNoChange(result, marked, before);
});

test("migrateCompactHeights is identity on a second application", () => {
  const input = freezeManifest(
    structuredClone(
      manifest([
        { ...a, height: 360 },
        { ...b, height: 90, collapsed: true },
      ]),
    ),
  );
  const once = migrateCompactHeights(input);
  assert.equal(once.compactHeights, true);
  assert.equal(once.blocks[0].height, 200);
  const twice = migrateCompactHeights(once);
  assert.equal(twice, once);
  assert.equal(twice.blocks[0].height, 200);
  assert.equal(twice.blocks[1].height, 200);
  assert.equal(twice.blocks[1].collapsed, true);
});

test("migrateCompactHeights marks a zero-block manifest and does not add a block", () => {
  const input = prepared([]);
  const before = structuredClone(input);
  const result = migrateCompactHeights(input);
  assert.equal(result.compactHeights, true);
  assert.deepEqual(result.blocks, []);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("sanitizeManifest keeps compactHeights on the root", () => {
  const input = freezeManifest(
    structuredClone({
      version: 1,
      title: "page",
      compactHeights: true,
      blocks: [{ ...a, height: 480 }],
    }),
  );
  const before = structuredClone(input);
  const result = sanitizeManifest(input);
  assert.equal(result.compactHeights, true);
  assert.equal(result.blocks[0].height, 480);
  assert.equal(result.version, 1);
  assert.equal(result.title, "page");
  assertUntouched(input, before);
});

test("parseManifest keeps compactHeights so migrateCompactHeights does not reset saved heights", () => {
  const value = {
    version: 1,
    title: "page",
    compactHeights: true,
    blocks: [{ ...a, height: 480, collapsed: true, folds: sampleFolds }],
  };
  const parsed = parseManifest(JSON.stringify(value));
  assert.ok(parsed);
  assert.equal(parsed.compactHeights, true);
  assert.equal(parsed.blocks[0].height, 480);
  const result = migrateCompactHeights(parsed);
  assert.equal(result.compactHeights, true);
  assert.equal(result.blocks[0].height, 480);
  assert.equal(result.blocks[0].collapsed, true);
  assert.deepEqual(result.blocks[0].folds, sampleFolds);
});

test("serialize then parse keeps compactHeights on a migrated manifest", () => {
  const migrated = migrateCompactHeights(
    freezeManifest(structuredClone(manifest([{ ...a, height: 360 }]))),
  );
  assert.equal(migrated.compactHeights, true);
  const parsed = parseManifest(serializeManifest(migrated));
  assert.ok(parsed);
  assert.equal(parsed.compactHeights, true);
  assert.equal(parsed.blocks[0].height, 200);
  const again = migrateCompactHeights(parsed);
  assert.equal(again.blocks[0].height, 200);
  assert.equal(again.compactHeights, true);
});
