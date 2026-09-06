const SNAPSHOT_KEY_PREFIX = "block-workspace:snapshot:";

export type BlockSnapshot = {
  version: number;
  lastAccessedAt?: number;
  blocks: Array<{
    id: string;
    title: string;
    language: string;
    content: string;
    height?: number;
    collapsed?: boolean;
    folds?: unknown;
  }>;
};

/** Web Storage subset used by snapshot load/save. Injected in tests. */
export type SnapshotStorage = {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
};

type WriteResult = "ok" | "quota" | "failed";

function snapshotKey(pageId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${pageId}`;
}

function resolveStorage(storage?: SnapshotStorage): SnapshotStorage {
  return storage ?? window.localStorage;
}

function isQuotaExceededError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return true;
  }
  const code =
    "code" in error ? Number((error as { code: unknown }).code) : NaN;
  return code === 22 || code === 1014;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseBlock(
  value: unknown,
): BlockSnapshot["blocks"][number] | undefined {
  const block = asRecord(value);
  if (!block) return undefined;
  if (
    typeof block.id !== "string" ||
    typeof block.title !== "string" ||
    typeof block.language !== "string"
  ) {
    return undefined;
  }
  if (block.content !== undefined && typeof block.content !== "string") {
    return undefined;
  }
  return {
    ...block,
    id: block.id,
    title: block.title,
    language: block.language,
    content: typeof block.content === "string" ? block.content : "",
  } as BlockSnapshot["blocks"][number];
}

function parseBlockSnapshot(raw: string): BlockSnapshot | undefined {
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (
      !parsed ||
      typeof parsed.version !== "number" ||
      !Array.isArray(parsed.blocks)
    ) {
      return undefined;
    }
    const blocks: BlockSnapshot["blocks"] = [];
    for (const entry of parsed.blocks) {
      const block = parseBlock(entry);
      if (!block) return undefined;
      blocks.push(block);
    }
    const snapshot = {
      ...parsed,
      version: parsed.version,
      blocks,
    } as BlockSnapshot;
    if (
      typeof parsed.lastAccessedAt === "number" &&
      Number.isFinite(parsed.lastAccessedAt)
    ) {
      snapshot.lastAccessedAt = parsed.lastAccessedAt;
    } else {
      delete snapshot.lastAccessedAt;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function lastAccessedAtOf(raw: string | null): number {
  if (!raw) return Number.NEGATIVE_INFINITY;
  const snapshot = parseBlockSnapshot(raw);
  return snapshot?.lastAccessedAt ?? Number.NEGATIVE_INFINITY;
}

function readLastAccessedAt(storage: SnapshotStorage, key: string): number {
  try {
    return lastAccessedAtOf(storage.getItem(key));
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function otherSnapshotKeys(storage: SnapshotStorage, pageId: string): string[] {
  const currentKey = snapshotKey(pageId);
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(SNAPSHOT_KEY_PREFIX) && key !== currentKey) {
      keys.push(key);
    }
  }
  return keys;
}

function pickOldestOtherSnapshotKey(
  storage: SnapshotStorage,
  pageId: string,
): string | undefined {
  const keys = otherSnapshotKeys(storage, pageId);
  if (keys.length === 0) return undefined;
  let oldestKey = keys[0];
  let oldestAt = readLastAccessedAt(storage, oldestKey);
  for (let i = 1; i < keys.length; i++) {
    const accessedAt = readLastAccessedAt(storage, keys[i]);
    if (accessedAt < oldestAt) {
      oldestKey = keys[i];
      oldestAt = accessedAt;
    }
  }
  return oldestKey;
}

function stampSnapshot(snapshot: BlockSnapshot): BlockSnapshot {
  return {
    ...snapshot,
    lastAccessedAt: Date.now(),
    blocks: snapshot.blocks.map((block) => ({ ...block })),
  };
}

function metadataOnly(snapshot: BlockSnapshot): BlockSnapshot {
  return {
    ...snapshot,
    blocks: snapshot.blocks.map((block) => ({
      ...block,
      content: "",
    })),
  };
}

function writeJson(
  storage: SnapshotStorage,
  key: string,
  snapshot: BlockSnapshot,
): WriteResult {
  try {
    storage.setItem(key, JSON.stringify(snapshot));
    return "ok";
  } catch (error) {
    return isQuotaExceededError(error) ? "quota" : "failed";
  }
}

function persistWithQuota(
  storage: SnapshotStorage,
  pageId: string,
  snapshot: BlockSnapshot,
): WriteResult {
  const key = snapshotKey(pageId);
  let result = writeJson(storage, key, snapshot);
  const evicted = new Set<string>();
  while (result === "quota") {
    const victim = pickOldestOtherSnapshotKey(storage, pageId);
    if (victim === undefined || evicted.has(victim)) break;
    evicted.add(victim);
    try {
      storage.removeItem(victim);
    } catch {
      break;
    }
    result = writeJson(storage, key, snapshot);
  }
  return result;
}

function writeMetadata(
  storage: SnapshotStorage,
  key: string,
  snapshot: BlockSnapshot,
): void {
  const meta = metadataOnly(snapshot);
  if (writeJson(storage, key, meta) !== "quota") return;
  try {
    storage.removeItem(key);
  } catch {
    // Overwrite may still work if the previous value is already gone.
  }
  writeJson(storage, key, meta);
}

export function saveBlockSnapshot(
  pageId: string,
  snapshot: BlockSnapshot,
  storage?: SnapshotStorage,
): void {
  try {
    const store = resolveStorage(storage);
    const stamped = stampSnapshot(snapshot);
    const result = persistWithQuota(store, pageId, stamped);
    if (result === "quota") {
      writeMetadata(store, snapshotKey(pageId), stamped);
    }
  } catch {
    // Snapshot cache must never interrupt editing.
  }
}

export function loadBlockSnapshot(
  pageId: string,
  storage?: SnapshotStorage,
): BlockSnapshot | undefined {
  try {
    const raw = resolveStorage(storage).getItem(snapshotKey(pageId));
    if (!raw) return undefined;
    return parseBlockSnapshot(raw);
  } catch {
    return undefined;
  }
}
