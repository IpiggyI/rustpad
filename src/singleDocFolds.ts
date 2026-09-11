const FOLDS_KEY_PREFIX = "single-doc:folds:";

/** Web Storage subset used by fold load/save. Injected in tests. */
export type FoldStorage = {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
};

export type FoldMap = Record<string, unknown>;

export type FoldSidecarState = {
  initialized: boolean;
  lastValid: FoldMap;
};

export function foldsSidecarId(docId: string): string {
  return `folds:${docId}`;
}

export function singleDocFoldsKey(id: string, language: string): string {
  return `${FOLDS_KEY_PREFIX}${id}:${language}`;
}

export function singleDocFoldsLegacyKey(id: string): string {
  return `${FOLDS_KEY_PREFIX}${id}`;
}

function resolveStorage(storage?: FoldStorage): FoldStorage {
  return storage ?? window.localStorage;
}

function parseRecord(raw: string | null): unknown {
  if (raw == null || raw === "") return undefined;
  return JSON.parse(raw);
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

export function parseFoldMap(text: string): FoldMap | null {
  if (!text.trim()) return null;
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = recoverFirstJsonValue(text);
      if (parsed === undefined) return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as FoldMap;
  } catch {
    return null;
  }
}

export function serializeFoldMap(map: FoldMap): string {
  const ordered: FoldMap = {};
  for (const key of Object.keys(map).sort()) {
    ordered[key] = map[key];
  }
  return JSON.stringify(ordered);
}

export function loadSingleDocFolds(
  id: string,
  language: string,
  storage?: FoldStorage,
): unknown {
  try {
    const store = resolveStorage(storage);
    const raw = store.getItem(singleDocFoldsKey(id, language));
    if (raw != null && raw !== "") {
      return parseRecord(raw);
    }
    if (language === "markdown") {
      return parseRecord(store.getItem(singleDocFoldsLegacyKey(id)));
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function saveSingleDocFolds(
  id: string,
  language: string,
  record: unknown,
  storage?: FoldStorage,
): void {
  // Unread (undefined) must not be stored as [] — that would look like a user unfold-all.
  if (record === undefined) return;
  try {
    resolveStorage(storage).setItem(
      singleDocFoldsKey(id, language),
      JSON.stringify(record),
    );
  } catch {
    // Fold cache must never interrupt editing.
  }
}

export function loadAllLocalFolds(id: string, storage?: FoldStorage): FoldMap {
  try {
    const store = resolveStorage(storage);
    const map: FoldMap = {};
    const prefix = `${FOLDS_KEY_PREFIX}${id}:`;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const language = key.slice(prefix.length);
      if (!language) continue;
      try {
        const record = parseRecord(store.getItem(key));
        if (record !== undefined) map[language] = record;
      } catch {
        // Skip a corrupt language key.
      }
    }
    if (map.markdown === undefined) {
      try {
        const record = parseRecord(store.getItem(singleDocFoldsLegacyKey(id)));
        if (record !== undefined) map.markdown = record;
      } catch {
        // Skip a corrupt legacy key.
      }
    }
    return map;
  } catch {
    return {};
  }
}

export function writeFoldMapToCache(
  id: string,
  map: FoldMap,
  storage?: FoldStorage,
): void {
  for (const language of Object.keys(map)) {
    saveSingleDocFolds(id, language, map[language], storage);
  }
}

export function mergeFoldLanguage(
  map: FoldMap,
  language: string,
  memento: unknown,
): FoldMap {
  return { ...map, [language]: memento };
}

/** Write `next` when `shouldWrite` is true. Returns the last-saved record. */
export function persistSingleDocFolds(
  id: string,
  language: string,
  next: unknown,
  saved: unknown,
  shouldWrite: boolean,
  storage?: FoldStorage,
): unknown {
  if (!shouldWrite || next === undefined) return saved;
  saveSingleDocFolds(id, language, next, storage);
  return next;
}

/**
 * Unmount/language-change flush: use a live memento when the model is still
 * the session language. Otherwise keep the last capture for that session.
 */
export function foldMementoForFlush(
  modelLanguage: string | undefined,
  sessionLanguage: string,
  liveMemento: unknown,
  lastSessionMemento: unknown,
): unknown {
  if (modelLanguage === sessionLanguage && liveMemento !== undefined) {
    return liveMemento;
  }
  return lastSessionMemento;
}

/** Cancel a pending persist debounce; last-good still has to land on unmount. */
export function flushFoldMementoOnUnmount(
  persist: { cancel(): void },
  modelLanguage: string | undefined,
  sessionLanguage: string,
  liveMemento: unknown,
  lastGood: unknown,
): unknown {
  persist.cancel();
  return foldMementoForFlush(
    modelLanguage,
    sessionLanguage,
    liveMemento,
    lastGood,
  );
}

/**
 * Init policy aligned with useManifest: seed only when the sidecar is
 * unusable and only before the first successful init; then the server wins.
 */
export function applyFoldSidecarText(
  text: string,
  state: FoldSidecarState,
  localSeed: FoldMap,
): { state: FoldSidecarState; writeText?: string } {
  const parsed = parseFoldMap(text);
  if (state.initialized) {
    const canonical = parsed ?? state.lastValid;
    const serialized = serializeFoldMap(canonical);
    const writeText =
      parsed === null || text !== serialized ? serialized : undefined;
    if (parsed) {
      return { state: { initialized: true, lastValid: parsed }, writeText };
    }
    return { state, writeText };
  }
  if (parsed) {
    return { state: { initialized: true, lastValid: parsed } };
  }
  return {
    state: { initialized: true, lastValid: localSeed },
    writeText: serializeFoldMap(localSeed),
  };
}
