export type BlockInfo = {
  id: string;
  title: string;
  language: string;
};

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

export function updateTitle(manifest: Manifest, title: string): Manifest {
  return {
    ...manifest,
    title,
  };
}

export function moveBlock(
  manifest: Manifest,
  blockId: string,
  direction: "up" | "down",
): Manifest {
  const idx = manifest.blocks.findIndex((b) => b.id === blockId);
  if (idx < 0) return manifest;
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (target < 0 || target >= manifest.blocks.length) return manifest;
  const blocks = [...manifest.blocks];
  [blocks[idx], blocks[target]] = [blocks[target], blocks[idx]];
  return { ...manifest, blocks };
}
