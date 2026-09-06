import assert from "node:assert/strict";
import { test } from "node:test";

import { diffText } from "../src/textDiff.ts";

/** Independent Unicode code-point count (not UTF-16 code units). */
function unicodeLength(str: string): number {
  return Array.from(str).length;
}

function insertedText(op: { to_string(): string }): string {
  const ops: (string | number)[] = JSON.parse(op.to_string());
  return ops.filter((part) => typeof part === "string").join("");
}

function assertRoundTrip(oldText: string, newText: string) {
  const op = diffText(oldText, newText);
  assert.equal(op.base_len(), unicodeLength(oldText));
  assert.equal(op.target_len(), unicodeLength(newText));
  assert.equal(op.apply(oldText), newText);
  return op;
}

const cases: { name: string; oldText: string; newText: string }[] = [
  { name: "pure append", oldText: "hello", newText: "hello!" },
  { name: "pure delete", oldText: "hello!", newText: "hello" },
  { name: "middle replace", oldText: "abcXdef", newText: "abcYdef" },
  { name: "prefix replace", oldText: "AAAmiddle", newText: "XXXmiddle" },
  { name: "suffix replace", oldText: "middleBBB", newText: "middleYYY" },
  {
    name: "both-ends replace",
    oldText: "AAAmiddleBBB",
    newText: "XXXmiddleYYY",
  },
  { name: "full replace", oldText: "aaa", newText: "bbb" },
  { name: "empty to nonempty", oldText: "", newText: "hello" },
  { name: "nonempty to empty", oldText: "hello", newText: "" },
  { name: "no change", oldText: "unchanged", newText: "unchanged" },
];

for (const { name, oldText, newText } of cases) {
  test(name, () => {
    assertRoundTrip(oldText, newText);
  });
}

test("does not split a UTF-16 surrogate pair at a prefix boundary", () => {
  // 😀 is U+1F600 (D83D DE00) and 😁 is U+1F601 (D83D DE01). They share a
  // high surrogate, so a naive UTF-16 prefix would end between the pair.
  const oldText = "🎉keep😀end✨";
  const newText = "🎉keep😁end✨";
  const emojiOffset = "🎉keep".length;
  assert.equal(oldText.charCodeAt(emojiOffset), 0xd83d);
  assert.equal(newText.charCodeAt(emojiOffset), 0xd83d);
  assert.notEqual(
    oldText.charCodeAt(emojiOffset + 1),
    newText.charCodeAt(emojiOffset + 1),
  );

  const op = assertRoundTrip(oldText, newText);
  assert.equal(insertedText(op), "😁");
});

test("changing one manifest numeric field yields a small insert", () => {
  const blocks = Array.from({ length: 19 }, (_, i) => ({
    id: `id${String(i).padStart(4, "0")}`,
    title: `Block ${i} extra title padding for size`,
    language: "plaintext",
    height: 200,
    collapsed: false,
  }));
  const oldText = JSON.stringify({ version: 1, title: "workspace", blocks });
  assert.ok(oldText.length >= 2000 && oldText.length <= 2500);

  const next = JSON.parse(oldText);
  next.blocks[5].height = 201;
  const newText = JSON.stringify(next);
  assert.notEqual(oldText, newText);

  const op = assertRoundTrip(oldText, newText);
  const inserted = insertedText(op);
  assert.ok(
    inserted.length >= 1 && inserted.length <= 99,
    `insert length ${inserted.length} should be 1-2 digit magnitude, got ${JSON.stringify(inserted)}`,
  );
  assert.ok(
    inserted.length < oldText.length / 10,
    "insert should be far smaller than the whole manifest",
  );
});
