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

function generateBlockId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function parseManifest(text: string): Manifest | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.blocks)) {
      return parsed as Manifest;
    }
  } catch {
    // corrupted JSON, ignore
  }
  return null;
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
): Manifest {
  return {
    ...manifest,
    blocks: [createDefaultBlock(language), ...manifest.blocks],
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
