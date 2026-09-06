import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BlockInfo,
  type Manifest,
  addBlock,
  moveBlock,
  parseManifest,
  removeBlock,
  sanitizeManifest,
  updateBlock,
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
