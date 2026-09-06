import { useCallback, useEffect, useRef, useState } from "react";

import {
  type BlockInfo,
  type Manifest,
  addBlock as addBlockToManifest,
  createDefaultBlock,
  moveBlock as moveBlockInManifest,
  parseManifest,
  removeBlock as removeBlockFromManifest,
  serializeManifest,
  updateTitle as setManifestTitle,
  updateBlock as updateBlockInManifest,
} from "./manifestOps";
import RustpadHeadless from "./rustpad-headless";
import { getWsUri } from "./useHash";

export { createDefaultBlock };
export type { BlockInfo, Manifest } from "./manifestOps";

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
    title: fallbackManifest.current.title,
    blocks: fallbackManifest.current.blocks,
  });
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const [ready, setReady] = useState(false);
  const headlessRef = useRef<RustpadHeadless>();
  const lastValidManifest = useRef<Manifest>(fallbackManifest.current);
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
        setReady(true);
        return;
      }
      // Server has no usable manifest (empty text, corrupt JSON, or zero blocks):
      // seed it once from the local initial / fallback manifest.
      if (!initialized.current) {
        const init: Manifest =
          initialManifestRef.current ?? fallbackManifest.current;
        initialized.current = true;
        lastValidManifest.current = init;
        setManifest(init);
        setReady(true);
        headless.replaceContent(serializeManifest(init));
        const block = init.blocks[0];
        if (initialBlockRef.current && block) {
          window.setTimeout(() => {
            const blockHeadless = new RustpadHeadless({
              uri: getWsUri(`page:${pageId}:block:${block.id}`),
              onContentReady: () => {
                blockHeadless.replaceContent(
                  initialBlockRef.current?.content ?? "",
                );
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
      setReady(false);
    };
  }, [pageId]);

  const updateManifest = useCallback(
    (updater: (prev: Manifest) => Manifest) => {
      if (!initialized.current) return;
      const next = updater(lastValidManifest.current);
      lastValidManifest.current = next;
      setManifest(next);
      headlessRef.current?.replaceContent(serializeManifest(next));
    },
    [],
  );

  const addBlock = useCallback(
    (language: string = "plaintext") => {
      updateManifest((prev) => addBlockToManifest(prev, language));
    },
    [updateManifest],
  );

  const updateTitle = useCallback(
    (title: string) => {
      updateManifest((prev) => setManifestTitle(prev, title));
    },
    [updateManifest],
  );

  const removeBlock = useCallback(
    (blockId: string) => {
      updateManifest((prev) => removeBlockFromManifest(prev, blockId));
    },
    [updateManifest],
  );

  const updateBlock = useCallback(
    (
      blockId: string,
      patch: Partial<Pick<BlockInfo, "title" | "language">>,
    ) => {
      updateManifest((prev) => updateBlockInManifest(prev, blockId, patch));
    },
    [updateManifest],
  );

  const moveBlock = useCallback(
    (blockId: string, direction: "up" | "down") => {
      updateManifest((prev) => moveBlockInManifest(prev, blockId, direction));
    },
    [updateManifest],
  );

  return {
    manifest,
    connection,
    ready,
    addBlock,
    updateTitle,
    removeBlock,
    updateBlock,
    moveBlock,
  };
}
