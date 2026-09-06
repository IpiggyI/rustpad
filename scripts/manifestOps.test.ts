import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BlockInfo,
  type Manifest,
  addBlock,
  moveBlock,
  parseManifest,
  removeBlock,
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

test("moveBlock up on the first block returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "aaaaaa", "up"), input, before);
});

test("moveBlock down on the last block returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "cccccc", "down"), input, before);
});

test("moveBlock on a single-block manifest returns an equivalent manifest", () => {
  const input = prepared([a]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "aaaaaa", "up"), input, before);
  assertNoChange(moveBlock(input, "aaaaaa", "down"), input, before);
});

test("moveBlock on an empty manifest returns an equivalent manifest", () => {
  const input = prepared([]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "aaaaaa", "up"), input, before);
  assertNoChange(moveBlock(input, "aaaaaa", "down"), input, before);
});

test("moveBlock with a missing id returns an equivalent manifest", () => {
  const input = prepared([a, b, c]);
  const before = structuredClone(input);
  assertNoChange(moveBlock(input, "nope00", "up"), input, before);
  assertNoChange(moveBlock(input, "nope00", "down"), input, before);
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
