export type BlockInfo = {
  id: string;
  title: string;
  language: string;
  height?: number;
  collapsed?: boolean;
  folds?: unknown;
};

export type BlockLayout = {
  height?: number;
  collapsed?: boolean;
  folds?: unknown;
};

export type Manifest = {
  version: number;
  title?: string;
  // Per-page one-time marker that existing block heights were reset to 200px.
  compactHeights?: boolean;
  blocks: BlockInfo[];
};

export const DEFAULT_BLOCK_BODY_HEIGHT = 200;

const BLOCK_ID = /^[a-z0-9]{6}$/;

function generateBlockId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function sanitizeManifest(manifest: Manifest): Manifest {
  const seen = new Set<string>();
  const blocks: BlockInfo[] = [];
  for (const entry of manifest.blocks as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !BLOCK_ID.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    blocks.push(entry as BlockInfo);
  }
  return { ...manifest, blocks };
}

// Concurrent first-open seeding can concatenate two JSON values ('{...}{...}').
function recoverFirstJsonValue(text: string): unknown | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      started = true;
      depth++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      if (!started || depth === 0) {
        return undefined;
      }
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(0, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

export function parseManifest(text: string): Manifest | null {
  if (!text.trim()) return null;
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = recoverFirstJsonValue(text);
      if (parsed === undefined) return null;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as Manifest).blocks)
    ) {
      return null;
    }
    return sanitizeManifest(parsed as Manifest);
  } catch {
    return null;
  }
}

export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest);
}

export function migrateCompactHeights(manifest: Manifest): Manifest {
  if (manifest.compactHeights === true) return manifest;
  return {
    ...manifest,
    compactHeights: true,
    blocks: manifest.blocks.map((block) => ({
      ...block,
      height: DEFAULT_BLOCK_BODY_HEIGHT,
    })),
  };
}

export function createDefaultBlock(language: string = "plaintext"): BlockInfo {
  return { id: generateBlockId(), title: "Untitled", language };
}

export function addBlock(
  manifest: Manifest,
  language: string = "plaintext",
  position: "start" | "end" = "start",
): Manifest {
  const block = createDefaultBlock(language);
  return {
    ...manifest,
    blocks:
      position === "end"
        ? [...manifest.blocks, block]
        : [block, ...manifest.blocks],
  };
}

export function addBlockAfter(
  manifest: Manifest,
  afterId: string | null,
  language: string = "plaintext",
): Manifest {
  const block = createDefaultBlock(language);
  const index = afterId
    ? manifest.blocks.findIndex((entry) => entry.id === afterId)
    : -1;
  const insertAt = index < 0 ? manifest.blocks.length : index + 1;
  const blocks = [...manifest.blocks];
  blocks.splice(insertAt, 0, block);
  return { ...manifest, blocks };
}

export function removeBlock(manifest: Manifest, blockId: string): Manifest {
  return {
    ...manifest,
    blocks: manifest.blocks.filter((b) => b.id !== blockId),
  };
}

export function updateBlock(
  manifest: Manifest,
  blockId: string,
  patch: Partial<Pick<BlockInfo, "title" | "language">>,
): Manifest {
  return {
    ...manifest,
    blocks: manifest.blocks.map((b) =>
      b.id === blockId ? { ...b, ...patch } : b,
    ),
  };
}

export function isEmptyFoldRecord(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function jsonValuesAreEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (!jsonValuesAreEqual(left[i], right[i])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!jsonValuesAreEqual(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

export function doesFoldRecordDiffer(next: unknown, saved: unknown): boolean {
  if (isEmptyFoldRecord(next) && isEmptyFoldRecord(saved)) return false;
  return !jsonValuesAreEqual(next, saved);
}

/**
 * Persist after restore when the live record differs.
 * `undefined` means the memento could not be read; do not wipe `saved`.
 * `[]` is a real cleared folding-model read and may replace `saved`.
 * Restoring and IME composition both skip persist (shared guard).
 */
export function shouldPersistSingleDocFolds(
  next: unknown,
  saved: unknown,
  restoring: boolean,
  composing: boolean = false,
): boolean {
  if (restoring || composing) return false;
  if (next === undefined) return false;
  return doesFoldRecordDiffer(next, saved);
}

function applyLayout(block: BlockInfo, layout: BlockLayout): BlockInfo | null {
  const next: BlockInfo = { ...block };
  let changed = false;
  if (layout.height !== undefined && layout.height !== block.height) {
    next.height = layout.height;
    changed = true;
  }
  if (layout.collapsed !== undefined && layout.collapsed !== block.collapsed) {
    next.collapsed = layout.collapsed;
    changed = true;
  }
  if (
    layout.folds !== undefined &&
    doesFoldRecordDiffer(layout.folds, block.folds)
  ) {
    next.folds = layout.folds;
    changed = true;
  }
  return changed ? next : null;
}

export function updateBlockLayout(
  manifest: Manifest,
  blockId: string,
  layout: BlockLayout,
): Manifest {
  const idx = manifest.blocks.findIndex((block) => block.id === blockId);
  if (idx < 0) return manifest;
  const nextBlock = applyLayout(manifest.blocks[idx], layout);
  if (!nextBlock) return manifest;
  const blocks = [...manifest.blocks];
  blocks[idx] = nextBlock;
  return { ...manifest, blocks };
}

export function migrateLegacyLayout(
  manifest: Manifest,
  legacy: Record<string, BlockLayout>,
): Manifest {
  let changed = false;
  const blocks = manifest.blocks.map((block) => {
    const fromLegacy = legacy[block.id];
    if (!fromLegacy) return block;
    const adopted: BlockLayout = {};
    if (block.height === undefined && fromLegacy.height !== undefined) {
      adopted.height = fromLegacy.height;
    }
    if (block.collapsed === undefined && fromLegacy.collapsed !== undefined) {
      adopted.collapsed = fromLegacy.collapsed;
    }
    const nextBlock = applyLayout(block, adopted);
    if (!nextBlock) return block;
    changed = true;
    return nextBlock;
  });
  if (!changed) return manifest;
  return { ...manifest, blocks };
}

export function updateTitle(manifest: Manifest, title: string): Manifest {
  return {
    ...manifest,
    title,
  };
}

export type MoveDirection = "up" | "down" | "top" | "bottom";

export function moveBlock(
  manifest: Manifest,
  blockId: string,
  direction: MoveDirection,
): Manifest {
  const idx = manifest.blocks.findIndex((b) => b.id === blockId);
  if (idx < 0) return manifest;
  const last = manifest.blocks.length - 1;
  const target = {
    up: idx - 1,
    down: idx + 1,
    top: 0,
    bottom: last,
  }[direction];
  if (target === idx || target < 0 || target > last) return manifest;
  const blocks = [...manifest.blocks];
  const [moved] = blocks.splice(idx, 1);
  blocks.splice(target, 0, moved);
  return { ...manifest, blocks };
}

export function moveBlockBefore(
  manifest: Manifest,
  blockId: string,
  beforeId: string | null,
): Manifest {
  const from = manifest.blocks.findIndex((block) => block.id === blockId);
  if (from < 0) return manifest;

  if (beforeId === null) {
    if (from === manifest.blocks.length - 1) return manifest;
    const blocks = [...manifest.blocks];
    const [moved] = blocks.splice(from, 1);
    blocks.push(moved);
    return { ...manifest, blocks };
  }

  if (beforeId === blockId) return manifest;

  const beforeIndex = manifest.blocks.findIndex(
    (block) => block.id === beforeId,
  );
  if (beforeIndex < 0) return manifest;
  if (from + 1 === beforeIndex) return manifest;

  const blocks = [...manifest.blocks];
  const [moved] = blocks.splice(from, 1);
  const insertAt = blocks.findIndex((block) => block.id === beforeId);
  blocks.splice(insertAt, 0, moved);
  return { ...manifest, blocks };
}
