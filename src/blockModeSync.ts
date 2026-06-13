export type SingleToBlockTransfer = {
  snapshot: BlockSnapshot;
  documentLanguage: string;
};

export type BlockToSingleTransfer = {
  content: string;
  language: string;
};

export type BlockSnapshot = {
  version: number;
  blocks: Array<{
    id: string;
    title: string;
    language: string;
    content: string;
  }>;
};

const blockHeaderPattern = /^\/\/ === (.+?) \((.+?)\) ===$/;

function singleToBlockKey(pageId: string) {
  return `block-mode:single-to-block:${pageId}`;
}

function blockToSingleKey(pageId: string) {
  return `block-mode:block-to-single:${pageId}`;
}

function snapshotKey(pageId: string) {
  return `block-mode:snapshot:${pageId}`;
}

function readTransfer<T>(key: string): T | undefined {
  const raw = window.sessionStorage.getItem(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function saveSingleToBlockTransfer(
  pageId: string,
  transfer: SingleToBlockTransfer,
) {
  window.sessionStorage.setItem(singleToBlockKey(pageId), JSON.stringify(transfer));
}

export function takeSingleToBlockTransfer(
  pageId: string,
): SingleToBlockTransfer | undefined {
  return readTransfer<SingleToBlockTransfer>(singleToBlockKey(pageId));
}

export function clearSingleToBlockTransfer(pageId: string) {
  window.sessionStorage.removeItem(singleToBlockKey(pageId));
}

export function saveBlockToSingleTransfer(
  pageId: string,
  transfer: BlockToSingleTransfer,
) {
  window.sessionStorage.setItem(blockToSingleKey(pageId), JSON.stringify(transfer));
}

export function takeBlockToSingleTransfer(
  pageId: string,
): BlockToSingleTransfer | undefined {
  return readTransfer<BlockToSingleTransfer>(blockToSingleKey(pageId));
}

export function clearBlockToSingleTransfer(pageId: string) {
  window.sessionStorage.removeItem(blockToSingleKey(pageId));
}

export function saveBlockSnapshot(pageId: string, snapshot: BlockSnapshot) {
  window.localStorage.setItem(snapshotKey(pageId), JSON.stringify(snapshot));
}

export function loadBlockSnapshot(pageId: string): BlockSnapshot | undefined {
  const raw = window.localStorage.getItem(snapshotKey(pageId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as BlockSnapshot;
  } catch {
    return undefined;
  }
}

function generateBlockId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function formatBlockSnapshot(snapshot: BlockSnapshot): string {
  return snapshot.blocks
    .map((block) =>
      [`// === ${block.title} (${block.language}) ===`, block.content].join("\n"),
    )
    .join("\n\n");
}

export function snapshotFromPlainText(
  content: string,
  language: string,
): BlockSnapshot {
  return {
    version: 1,
    blocks: [
      {
        id: generateBlockId(),
        title: "Untitled",
        language,
        content,
      },
    ],
  };
}

export function parseBlockText(
  content: string,
  fallbackLanguage: string,
): BlockSnapshot {
  const lines = content.split(/\r?\n/);
  const blocks: BlockSnapshot["blocks"] = [];
  let current:
    | {
        title: string;
        language: string;
        lines: string[];
      }
    | undefined;

  for (const line of lines) {
    const match = line.match(blockHeaderPattern);
    if (match) {
      if (current) {
        blocks.push({
          id: generateBlockId(),
          title: current.title,
          language: current.language,
          content: current.lines.join("\n").replace(/\n$/, ""),
        });
      }
      current = { title: match[1], language: match[2], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    blocks.push({
      id: generateBlockId(),
      title: current.title,
      language: current.language,
      content: current.lines.join("\n").replace(/\n$/, ""),
    });
  }

  if (blocks.length === 0) {
    return snapshotFromPlainText(content, fallbackLanguage);
  }
  return { version: 1, blocks };
}
