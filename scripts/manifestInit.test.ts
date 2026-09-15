import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ManifestInitDecision,
  decideManifestInit,
} from "../src/manifestInit.ts";
import {
  type BlockInfo,
  type Manifest,
  migrateCompactHeights,
  serializeManifest,
} from "../src/manifestOps.ts";

function block(
  id: string,
  title: string = id,
  language: string = "plaintext",
  extra: Partial<BlockInfo> = {},
): BlockInfo {
  return { id, title, language, ...extra };
}

const a = block("aaaaaa", "A", "markdown");
const b = block("bbbbbb", "B", "python");

const fallback: Manifest = {
  version: 1,
  title: "fallback",
  blocks: [block("ffffff", "Fallback", "plaintext")],
};

const sampleFolds = [
  {
    startLineNumber: 1,
    endLineNumber: 4,
    isCollapsed: true,
    checksum: 42,
  },
];

function applyDecision(decision: ManifestInitDecision): Manifest | undefined {
  if (decision.action !== "adopt") return undefined;
  return decision.shouldMigrate
    ? migrateCompactHeights(decision.manifest)
    : decision.manifest;
}

test("decideManifestInit defers before the first full replay even when the text is empty", () => {
  const decision = decideManifestInit({
    firstFullReplayCompleted: false,
    authoritativeRawText: "",
    parsed: null,
    snapshot: undefined,
    fallback,
  });
  assert.equal(decision.action, "defer");
  assert.equal(applyDecision(decision), undefined);
});

test("decideManifestInit does not migrate or seed a half-replayed document before ready", () => {
  const partial: Manifest = {
    version: 1,
    blocks: [block("aaaaaa", "A", "markdown", { height: 300 })],
  };
  const snapshot: Manifest = {
    version: 1,
    title: "snapshot",
    blocks: [block("ssssss", "Snap", "markdown", { height: 480 })],
  };
  const decision = decideManifestInit({
    firstFullReplayCompleted: false,
    authoritativeRawText: '{"version":1,"blocks":[]}',
    parsed: { version: 1, blocks: [] },
    snapshot,
    fallback,
  });
  assert.equal(decision.action, "defer");
  assert.equal(applyDecision(decision), undefined);

  const fromPartial = decideManifestInit({
    firstFullReplayCompleted: false,
    authoritativeRawText: serializeManifest(partial),
    parsed: partial,
    snapshot,
    fallback,
  });
  assert.equal(fromPartial.action, "defer");
  assert.equal(applyDecision(fromPartial), undefined);
});

test("decideManifestInit migrates a page with no saved heights after ready", () => {
  const parsed: Manifest = { version: 1, title: "page", blocks: [a, b] };
  const decision = decideManifestInit({
    firstFullReplayCompleted: true,
    authoritativeRawText: serializeManifest(parsed),
    parsed,
    snapshot: undefined,
    fallback,
  });
  assert.equal(decision.action, "adopt");
  assert.equal(decision.shouldMigrate, true);
  assert.equal(decision.manifest, parsed);
  const adopted = applyDecision(decision)!;
  assert.equal(adopted.compactHeights, true);
  assert.equal(adopted.blocks[0].height, 200);
  assert.equal(adopted.blocks[1].height, 200);
  assert.equal(adopted.blocks[0].title, "A");
  assert.equal(adopted.blocks[1].language, "python");
  assert.equal(adopted.title, "page");
});

test("decideManifestInit migrates mixed manual heights after ready", () => {
  const parsed: Manifest = {
    version: 1,
    title: "page",
    blocks: [
      block("aaaaaa", "A", "markdown", {
        height: 480,
        collapsed: true,
        folds: sampleFolds,
      }),
      block("bbbbbb", "B", "python", { height: 120 }),
    ],
  };
  const decision = decideManifestInit({
    firstFullReplayCompleted: true,
    authoritativeRawText: serializeManifest(parsed),
    parsed,
    snapshot: undefined,
    fallback,
  });
  assert.equal(decision.action, "adopt");
  assert.equal(decision.shouldMigrate, true);
  const adopted = applyDecision(decision)!;
  assert.equal(adopted.compactHeights, true);
  assert.equal(adopted.blocks[0].height, 200);
  assert.equal(adopted.blocks[1].height, 200);
  assert.equal(adopted.blocks[0].collapsed, true);
  assert.deepEqual(adopted.blocks[0].folds, sampleFolds);
  assert.equal(adopted.blocks[0].title, "A");
  assert.equal(adopted.blocks.length, 2);
});

test("decideManifestInit does not migrate an already-marked page", () => {
  const parsed: Manifest = {
    version: 1,
    title: "page",
    compactHeights: true,
    blocks: [
      block("aaaaaa", "A", "markdown", { height: 480, collapsed: true }),
      block("bbbbbb", "B", "python", { height: 120 }),
    ],
  };
  const decision = decideManifestInit({
    firstFullReplayCompleted: true,
    authoritativeRawText: serializeManifest(parsed),
    parsed,
    snapshot: undefined,
    fallback,
  });
  assert.equal(decision.action, "adopt");
  assert.equal(decision.shouldMigrate, false);
  assert.equal(decision.manifest, parsed);
  const adopted = applyDecision(decision)!;
  assert.equal(adopted, parsed);
  assert.equal(adopted.blocks[0].height, 480);
  assert.equal(adopted.blocks[1].height, 120);
  assert.equal(adopted.compactHeights, true);
});

test("decideManifestInit prefers a marked server manifest over a stale unmarked snapshot", () => {
  const parsed: Manifest = {
    version: 1,
    title: "server",
    compactHeights: true,
    blocks: [block("aaaaaa", "A", "markdown", { height: 420 })],
  };
  const snapshot: Manifest = {
    version: 1,
    title: "snapshot",
    blocks: [block("aaaaaa", "A", "markdown", { height: 300 })],
  };
  const decision = decideManifestInit({
    firstFullReplayCompleted: true,
    authoritativeRawText: serializeManifest(parsed),
    parsed,
    snapshot,
    fallback,
  });
  assert.equal(decision.action, "adopt");
  assert.equal(decision.shouldMigrate, false);
  assert.equal(decision.manifest, parsed);
  const adopted = applyDecision(decision)!;
  assert.equal(adopted.blocks[0].height, 420);
  assert.equal(adopted.compactHeights, true);
  assert.equal(adopted.title, "server");
});

test("decideManifestInit on a second load after migration leaves a manual height in place", () => {
  const first: Manifest = {
    version: 1,
    title: "page",
    blocks: [block("aaaaaa", "A", "markdown", { height: 360 })],
  };
  const afterFirst = applyDecision(
    decideManifestInit({
      firstFullReplayCompleted: true,
      authoritativeRawText: serializeManifest(first),
      parsed: first,
      snapshot: undefined,
      fallback,
    }),
  )!;
  assert.equal(afterFirst.compactHeights, true);
  assert.equal(afterFirst.blocks[0].height, 200);

  const resized: Manifest = {
    ...afterFirst,
    blocks: [{ ...afterFirst.blocks[0], height: 480 }],
  };
  const second = decideManifestInit({
    firstFullReplayCompleted: true,
    authoritativeRawText: serializeManifest(resized),
    parsed: resized,
    snapshot: first,
    fallback,
  });
  assert.equal(second.action, "adopt");
  assert.equal(second.shouldMigrate, false);
  const adopted = applyDecision(second)!;
  assert.equal(adopted.blocks[0].height, 480);
  assert.equal(adopted.compactHeights, true);
});

test("decideManifestInit adopts a zero-block parsed manifest and migrates without adding a block", () => {
  const parsed: Manifest = { version: 1, title: "empty", blocks: [] };
  const decision = decideManifestInit({
    firstFullReplayCompleted: true,
    authoritativeRawText: serializeManifest(parsed),
    parsed,
    snapshot: fallback,
    fallback,
  });
  assert.equal(decision.action, "adopt");
  assert.equal(decision.shouldMigrate, true);
  assert.equal(decision.manifest, parsed);
  const adopted = applyDecision(decision)!;
  assert.equal(adopted.compactHeights, true);
  assert.deepEqual(adopted.blocks, []);
  assert.equal(adopted.title, "empty");
});

test("decideManifestInit uses the snapshot only when the authoritative text is empty", () => {
  const snapshot: Manifest = {
    version: 1,
    title: "snapshot",
    compactHeights: true,
    blocks: [block("ssssss", "Snap", "markdown", { height: 420 })],
  };
  const decision = decideManifestInit({
    firstFullReplayCompleted: true,
    authoritativeRawText: "",
    parsed: null,
    snapshot,
    fallback,
  });
  assert.equal(decision.action, "adopt");
  assert.equal(decision.shouldMigrate, false);
  assert.equal(decision.manifest, snapshot);
  const adopted = applyDecision(decision)!;
  assert.equal(adopted.blocks[0].height, 420);
  assert.equal(adopted.compactHeights, true);
});

test("decideManifestInit uses the fallback when the authoritative text is empty and there is no snapshot", () => {
  const decision = decideManifestInit({
    firstFullReplayCompleted: true,
    authoritativeRawText: "   \n",
    parsed: null,
    snapshot: undefined,
    fallback,
  });
  assert.equal(decision.action, "adopt");
  assert.equal(decision.shouldMigrate, true);
  assert.equal(decision.manifest, fallback);
  const adopted = applyDecision(decision)!;
  assert.equal(adopted.compactHeights, true);
  assert.equal(adopted.blocks[0].height, 200);
  assert.equal(adopted.blocks[0].id, "ffffff");
});

test("decideManifestInit does not seed when authoritative text is non-empty but unparseable", () => {
  const snapshot: Manifest = {
    version: 1,
    blocks: [block("ssssss", "Snap", "markdown")],
  };
  const decision = decideManifestInit({
    firstFullReplayCompleted: true,
    authoritativeRawText: "{not json",
    parsed: null,
    snapshot,
    fallback,
  });
  assert.equal(decision.action, "unusable");
  assert.equal(applyDecision(decision), undefined);
});
