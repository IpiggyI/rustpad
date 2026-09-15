import assert from "node:assert/strict";
import { test } from "node:test";

import { planHeadingEnter } from "../src/markdownFolding.ts";

test("preserves six heading markers when the last folded line is empty", () => {
  assert.deepEqual(
    planHeadingEnter({
      lines: ["###### Six", ""],
      language: "markdown",
      position: { lineNumber: 1, column: 11 },
      cursorCount: 1,
      selectionEmpty: true,
      collapsedRegions: [{ startLineNumber: 1, endLineNumber: 2 }],
    }),
    {
      lineNumber: 2,
      column: 1,
      text: "\n###### ",
      caretLineNumber: 3,
      caretColumn: 8,
    },
  );
});

test("a collapsed heading at EOF appends an empty sibling", () => {
  assert.deepEqual(
    planHeadingEnter({
      lines: ["## 1", "111"],
      language: "markdown",
      position: { lineNumber: 1, column: 5 },
      cursorCount: 1,
      selectionEmpty: true,
      collapsedRegions: [{ startLineNumber: 1, endLineNumber: 2 }],
    }),
    {
      lineNumber: 2,
      column: 4,
      text: "\n## ",
      caretLineNumber: 3,
      caretColumn: 4,
    },
  );
});

for (const following of ["## Next", "# Parent"]) {
  test(`inserts immediately before ${following}`, () => {
    assert.deepEqual(
      planHeadingEnter({
        lines: ["## Original", "body", following, "next body"],
        language: "markdown",
        position: { lineNumber: 1, column: 12 },
        cursorCount: 1,
        selectionEmpty: true,
        collapsedRegions: [{ startLineNumber: 1, endLineNumber: 2 }],
      }),
      {
        lineNumber: 3,
        column: 1,
        text: "## \n",
        caretLineNumber: 3,
        caretColumn: 4,
      },
    );
  });
}

test("inserts after all nested headings and preserves the heading level", () => {
  assert.deepEqual(
    planHeadingEnter({
      lines: [
        "# Root",
        "body",
        "## Child",
        "child body",
        "### Leaf",
        "leaf body",
      ],
      language: "markdown",
      position: { lineNumber: 1, column: 7 },
      cursorCount: 1,
      selectionEmpty: true,
      collapsedRegions: [
        { startLineNumber: 3, endLineNumber: 6 },
        { startLineNumber: 1, endLineNumber: 6 },
      ],
    }),
    {
      lineNumber: 6,
      column: 10,
      text: "\n# ",
      caretLineNumber: 7,
      caretColumn: 3,
    },
  );
});

for (const [name, override] of [
  ["expanded heading", { collapsedRegions: [] }],
  ["mid-line caret", { position: { lineNumber: 1, column: 3 } }],
  ["other language", { language: "plaintext" }],
  ["selection", { selectionEmpty: false }],
  ["multiple cursors", { cursorCount: 2 }],
  ["non-heading", { lines: ["text", "body"] }],
]) {
  test(`leaves ${name} unchanged`, () => {
    assert.equal(
      planHeadingEnter({
        lines: ["## 1", "body"],
        language: "markdown",
        position: { lineNumber: 1, column: 5 },
        cursorCount: 1,
        selectionEmpty: true,
        collapsedRegions: [{ startLineNumber: 1, endLineNumber: 2 }],
        ...override,
      }),
      null,
    );
  });
}
