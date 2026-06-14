export type BlockSnapshot = {
  version: number;
  blocks: Array<{
    id: string;
    title: string;
    language: string;
    content: string;
  }>;
};

function snapshotKey(pageId: string) {
  return `block-workspace:snapshot:${pageId}`;
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
