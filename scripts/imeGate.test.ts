import assert from "node:assert/strict";
import { test } from "node:test";

import { createImeGate } from "../src/imeGate.ts";

test("does not emit parent updates while composing", () => {
  const gate = createImeGate();
  gate.start();
  assert.equal(gate.shouldEmitChange(true), false);
  assert.equal(gate.shouldEmitChange(false), false);
  assert.equal(gate.shouldApplyExternalValue(), false);
});

test("emits after composition ends", () => {
  const gate = createImeGate();
  gate.start();
  gate.end();
  assert.equal(gate.shouldEmitChange(false), true);
  assert.equal(gate.shouldApplyExternalValue(), true);
});

test("blocks emit when only the event isComposing flag is set", () => {
  const gate = createImeGate();
  assert.equal(gate.shouldEmitChange(true), false);
  assert.equal(gate.shouldApplyExternalValue(), true);
});

test("blur after compositionend still allows emit", () => {
  const gate = createImeGate();
  gate.start();
  gate.end();
  gate.end();
  assert.equal(gate.shouldEmitChange(false), true);
});
