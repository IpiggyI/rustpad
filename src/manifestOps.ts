export type BlockInfo = {
  id: string;
  title: string;
  language: string;
  height?: number;
  collapsed?: boolean;
};

export type BlockLayout = { height?: number; collapsed?: boolean };

export type Manifest = {
  version: number;
  title?: string;
  blocks: BlockInfo[];
};

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
