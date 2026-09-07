import assert from "node:assert/strict";
import { test } from "node:test";

import { parseHashString } from "../src/useHash.ts";

test("page: prefix opens block mode", () => {
  assert.deepEqual(parseHashString("page:abc123"), {
    type: "page",
    id: "abc123",
  });
});

test("folds: prefix is reserved and is not a single-doc id", () => {
  assert.equal(parseHashString("folds:abc123").type, "folds");
  assert.notDeepEqual(parseHashString("folds:abc123"), {
    type: "single",
    id: "folds:abc123",
  });
});

test("folds: with no rest is still reserved", () => {
  assert.equal(parseHashString("folds:").type, "folds");
});

test("a bare document id is ordinary single-doc mode", () => {
  assert.deepEqual(parseHashString("abc123"), {
    type: "single",
    id: "abc123",
  });
});

test("empty hash is not a folds sidecar document", () => {
  assert.equal(parseHashString("").type, "empty");
});
