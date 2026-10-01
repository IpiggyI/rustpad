/** Web Storage subset used by the recent-pages record. Injected in tests. */
export type RecentPagesStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type RecentPageEntry = {
  id: string;
  title: string;
  openedAt: number;
};

/** One key for this device. Not a block snapshot key. */
export const RECENT_PAGES_STORAGE_KEY = "recentPages";

function resolveStorage(storage?: RecentPagesStorage): RecentPagesStorage {
  return storage ?? window.localStorage;
}

function byNewest(a: RecentPageEntry, b: RecentPageEntry): number {
  if (a.openedAt !== b.openedAt) return b.openedAt - a.openedAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function parseEntry(value: unknown): RecentPageEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return null;
  if (typeof record.title !== "string") return null;
  if (
    typeof record.openedAt !== "number" ||
    !Number.isFinite(record.openedAt)
  ) {
    return null;
  }
  return { id: record.id, title: record.title, openedAt: record.openedAt };
}

function parseStored(raw: string): RecentPageEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: RecentPageEntry[] = [];
  for (const item of parsed) {
    const entry = parseEntry(item);
    if (!entry) return [];
    const index = entries.findIndex((existing) => existing.id === entry.id);
    if (index < 0) {
      entries.push(entry);
      continue;
    }
    if (entry.openedAt >= entries[index].openedAt) entries[index] = entry;
  }
  return entries.sort(byNewest);
}

function writeEntries(
  entries: RecentPageEntry[],
  storage: RecentPagesStorage,
): void {
  try {
    storage.setItem(RECENT_PAGES_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // A failed recent-pages write must not break the page.
  }
}

export function loadRecentPages(
  storage?: RecentPagesStorage,
): RecentPageEntry[] {
  try {
    const raw = resolveStorage(storage).getItem(RECENT_PAGES_STORAGE_KEY);
    if (raw == null || raw === "") return [];
    return parseStored(raw);
  } catch {
    return [];
  }
}

export function recordRecentPage(
  pageId: string,
  openedAt: number,
  storage?: RecentPagesStorage,
): void {
  if (pageId === "") return;
  try {
    const store = resolveStorage(storage);
    const current = loadRecentPages(store);
    const previous = current.find((entry) => entry.id === pageId);
    const next = current.filter((entry) => entry.id !== pageId);
    next.push({
      id: pageId,
      title: previous?.title ?? "",
      openedAt,
    });
    next.sort(byNewest);
    writeEntries(next, store);
  } catch {
    // A failed recent-pages write must not break the page.
  }
}

export function updateRecentPageTitle(
  pageId: string,
  title: string,
  storage?: RecentPagesStorage,
): void {
  try {
    const store = resolveStorage(storage);
    const current = loadRecentPages(store);
    const index = current.findIndex((entry) => entry.id === pageId);
    if (index < 0 || current[index].title === title) return;
    const next = current.slice();
    next[index] = { ...current[index], title };
    writeEntries(next, store);
  } catch {
    // A failed recent-pages write must not break the page.
  }
}

export function removeRecentPage(
  pageId: string,
  storage?: RecentPagesStorage,
): void {
  try {
    const store = resolveStorage(storage);
    const next = loadRecentPages(store).filter((entry) => entry.id !== pageId);
    writeEntries(next, store);
  } catch {
    // A failed recent-pages write must not break the page.
  }
}
