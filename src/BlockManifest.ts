import { useCallback, useEffect, useRef, useState } from "react";

import RustpadHeadless from "./rustpad-headless";
import { getWsUri } from "./useHash";

export type BlockInfo = {
  id: string;
  title: string;
  language: string;
};

export type Manifest = {
  version: number;
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

function parseManifest(text: string): Manifest | null {
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

function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest);
}

export function createDefaultBlock(language: string = "plaintext"): BlockInfo {
  return { id: generateBlockId(), title: "Untitled", language };
}

export function useManifest(
  pageId: string,
  options: {
    initialBlock?: { content: string; language: string };
    initialManifest?: Manifest;
  } = {},
) {
  const fallbackManifest = useRef<Manifest>(
    options.initialManifest ?? {
      version: 1,
      blocks: [createDefaultBlock(options.initialBlock?.language)],
    },
  );
  const [manifest, setManifest] = useState<Manifest>({
    version: 1,
    blocks: fallbackManifest.current.blocks,
  });
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const headlessRef = useRef<RustpadHeadless>();
  const lastValidManifest = useRef<Manifest>(
    fallbackManifest.current,
  );
  const initialized = useRef(false);
  const initialBlockRef = useRef(options.initialBlock);
  const initialManifestRef = useRef(options.initialManifest);

  useEffect(() => {
    function initialize(text: string, headless: RustpadHeadless) {
      const parsed = parseManifest(text);
      if (parsed && parsed.blocks.length > 0) {
        // Server already holds a manifest: the server is the source of truth.
        // Never overwrite it with the local initial manifest, which would revert
        // remote edits (e.g. blocks added by another client) and fight back and
        // forth with other clients.
        lastValidManifest.current = parsed;
        setManifest(parsed);
        initialized.current = true;
        return;
      }
      // Server has no usable manifest (empty text, corrupt JSON, or zero blocks):
      // seed it once from the local initial / fallback manifest.
      if (!initialized.current) {
        const init: Manifest = initialManifestRef.current ?? fallbackManifest.current;
        initialized.current = true;
        lastValidManifest.current = init;
        setManifest(init);
        headless.replaceContent(serializeManifest(init));
        const block = init.blocks[0];
        if (initialBlockRef.current && block) {
          window.setTimeout(() => {
            const blockHeadless = new RustpadHeadless({
              uri: getWsUri(`page:${pageId}:block:${block.id}`),
              onContentReady: () => {
                blockHeadless.replaceContent(initialBlockRef.current?.content ?? "");
                window.setTimeout(() => blockHeadless.dispose(), 100);
              },
            });
          }, 0);
        }
      }
    }

    const docId = `page:${pageId}:manifest`;
    const headless = new RustpadHeadless({
      uri: getWsUri(docId),
      onConnected: () => setConnection("connected"),
      onDisconnected: () => setConnection("disconnected"),
      onDesynchronized: () => setConnection("desynchronized"),
      onContentReady: (text) => initialize(text, headless),
      onContentChanged: (text) => initialize(text, headless),
    });
    headlessRef.current = headless;
    return () => {
      headless.dispose();
      headlessRef.current = undefined;
      initialized.current = false;
    };
  }, [pageId]);

  const updateManifest = useCallback((updater: (prev: Manifest) => Manifest) => {
    const next = updater(lastValidManifest.current);
    lastValidManifest.current = next;
    setManifest(next);
    headlessRef.current?.replaceContent(serializeManifest(next));
  }, []);

  const addBlock = useCallback(
    (language: string = "plaintext") => {
      updateManifest((prev) => ({
        ...prev,
        blocks: [
          ...prev.blocks,
          { id: generateBlockId(), title: "Untitled", language },
        ],
      }));
    },
    [updateManifest],
  );

  const removeBlock = useCallback(
    (blockId: string) => {
      updateManifest((prev) => ({
        ...prev,
        blocks: prev.blocks.filter((b) => b.id !== blockId),
      }));
    },
    [updateManifest],
  );

  const updateBlock = useCallback(
    (blockId: string, patch: Partial<Pick<BlockInfo, "title" | "language">>) => {
      updateManifest((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) =>
          b.id === blockId ? { ...b, ...patch } : b,
        ),
      }));
    },
    [updateManifest],
  );

  const moveBlock = useCallback(
    (blockId: string, direction: "up" | "down") => {
      updateManifest((prev) => {
        const idx = prev.blocks.findIndex((b) => b.id === blockId);
        if (idx < 0) return prev;
        const target = direction === "up" ? idx - 1 : idx + 1;
        if (target < 0 || target >= prev.blocks.length) return prev;
        const blocks = [...prev.blocks];
        [blocks[idx], blocks[target]] = [blocks[target], blocks[idx]];
        return { ...prev, blocks };
      });
    },
    [updateManifest],
  );

  return {
    manifest,
    connection,
    addBlock,
    removeBlock,
    updateBlock,
    moveBlock,
  };
}
