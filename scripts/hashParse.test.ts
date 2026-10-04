import assert from "node:assert/strict";
import { test } from "node:test";

import { parseHashString } from "../src/useHash.ts";

test("page: prefix opens block mode", () => {
  assert.deepEqual(parseHashString("page:abc123"), {
    mode: "blocks",
    id: "abc123",
  });
});

test("folds: prefix is reserved and is not a single-doc id", () => {
  assert.deepEqual(parseHashString("folds:abc123"), { mode: "new-single" });
  assert.notDeepEqual(parseHashString("folds:abc123"), {
    mode: "single",
    id: "folds:abc123",
  });
});

test("folds: with no rest is still reserved", () => {
  assert.deepEqual(parseHashString("folds:"), { mode: "new-single" });
});

test("a bare document id is ordinary single-doc mode", () => {
  assert.deepEqual(parseHashString("abc123"), {
    mode: "single",
    id: "abc123",
  });
});

test("an empty hash routes to the home page", () => {
  assert.deepEqual(parseHashString(""), { mode: "home" });
});
