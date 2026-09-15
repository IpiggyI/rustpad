/** Web Storage subset used by current-block load/save. Injected in tests. */
export type CurrentBlockStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type BlockIdRef = {
  readonly id: string;
};

export function currentBlockStorageKey(pageId: string): string {
  return `currentBlock:page:${pageId}`;
}

function resolveStorage(storage?: CurrentBlockStorage): CurrentBlockStorage {
  return storage ?? window.localStorage;
}

export function resolveCurrentBlockId(
  storedId: string | null | undefined,
  blocks: readonly BlockIdRef[],
): string | null {
  if (blocks.length === 0) return null;
  if (storedId && blocks.some((block) => block.id === storedId)) {
    return storedId;
  }
  return blocks[0].id;
}

export function chooseReplacementBlockId(
  previousBlocks: readonly BlockIdRef[] | null | undefined,
  currentBlocks: readonly BlockIdRef[],
  removedId: string,
): string | null {
  if (currentBlocks.length === 0) return null;
  if (!previousBlocks || previousBlocks.length === 0) {
    return currentBlocks[0].id;
  }
  const currentIds = new Set(currentBlocks.map((block) => block.id));
  const index = previousBlocks.findIndex((block) => block.id === removedId);
  if (index < 0) return currentBlocks[0].id;
  for (let i = index + 1; i < previousBlocks.length; i++) {
    const id = previousBlocks[i].id;
    if (currentIds.has(id)) return id;
  }
  for (let i = index - 1; i >= 0; i--) {
    const id = previousBlocks[i].id;
    if (currentIds.has(id)) return id;
  }
  return currentBlocks[0].id;
}

export function loadCurrentBlockId(
  pageId: string,
  storage?: CurrentBlockStorage,
): string | null {
  try {
    const raw = resolveStorage(storage).getItem(currentBlockStorageKey(pageId));
    if (raw == null || raw === "") return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveCurrentBlockId(
  pageId: string,
  blockId: string | null,
  storage?: CurrentBlockStorage,
): void {
  try {
    const store = resolveStorage(storage);
    const key = currentBlockStorageKey(pageId);
    if (blockId == null || blockId === "") {
      store.removeItem(key);
      return;
    }
    store.setItem(key, blockId);
  } catch {
    // Current-block cache must never interrupt editing.
  }
}
