import { useCallback, useEffect, useRef, useState } from "react";

import { decideManifestInit } from "./manifestInit";
import {
  type BlockInfo,
  type BlockLayout,
  type Manifest,
  type MoveDirection,
  addBlock as addBlockToManifest,
  createDefaultBlock,
  migrateCompactHeights,
  migrateLegacyLayout as migrateLegacyLayoutInManifest,
  moveBlockBefore as moveBlockBeforeInManifest,
  moveBlock as moveBlockInManifest,
  parseManifest,
  removeBlock as removeBlockFromManifest,
  serializeManifest,
  updateTitle as setManifestTitle,
  updateBlock as updateBlockInManifest,
  updateBlockLayout as updateBlockLayoutInManifest,
} from "./manifestOps";
import RustpadHeadless from "./rustpad-headless";
import { getWsUri } from "./useHash";

export { createDefaultBlock };
export { migrateLegacyLayout, updateBlockLayout } from "./manifestOps";
export type {
  BlockInfo,
  BlockLayout,
  Manifest,
  MoveDirection,
} from "./manifestOps";

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
    ...fallbackManifest.current,
  });
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const [ready, setReady] = useState(false);
  const headlessRef = useRef<RustpadHeadless>();
  const lastValidManifest = useRef<Manifest>(fallbackManifest.current);
  const initialized = useRef(false);
  const replayReady = useRef(false);
  const initialBlockRef = useRef(options.initialBlock);
  const initialManifestRef = useRef(options.initialManifest);

  useEffect(() => {
    function initialize(
      text: string,
      headless: RustpadHeadless,
      firstFullReplayCompleted: boolean,
    ) {
      const parsed = parseManifest(text);
      if (initialized.current) {
        // shortcut: rewrite unparseable or non-canonical server text after init because every client derives the same canonical text from the same raw text and replaceContent is a no-op when unchanged; ceiling: character-level OT carrying a structured manifest can only remove syntactic damage, not semantic damage (concurrent drag-reorder, one client deleting a block while another edits its title); replace when: concurrent structural edits are observed to leave a parseable manifest whose block set or order matches neither client's last write
        if (parsed === null || text !== serializeManifest(parsed)) {
          headless.replaceContent(
            serializeManifest(parsed ?? lastValidManifest.current),
          );
        }
        if (parsed) {
          lastValidManifest.current = parsed;
          setManifest(parsed);
        }
        return;
      }
      const decision = decideManifestInit({
        firstFullReplayCompleted,
        authoritativeRawText: text,
        parsed,
        snapshot: initialManifestRef.current,
        fallback: fallbackManifest.current,
      });
      if (decision.action !== "adopt") {
        return;
      }
      const next = decision.shouldMigrate
        ? migrateCompactHeights(decision.manifest)
        : decision.manifest;
      lastValidManifest.current = next;
      setManifest(next);
      initialized.current = true;
      setReady(true);
      const seeded = parsed === null;
      if (decision.shouldMigrate || seeded) {
        headless.replaceContent(serializeManifest(next));
      }
      if (seeded) {
        const block = next.blocks[0];
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
      onContentReady: (text) => {
        replayReady.current = true;
        initialize(text, headless, true);
      },
      // onContentChanged also fires during the first history replay; the latch
      // stays false until onContentReady, then true so a later change can still
      // initialize if the ready payload was unusable.
      onContentChanged: (text) =>
        initialize(text, headless, replayReady.current),
    });
    headlessRef.current = headless;
    return () => {
      headless.dispose();
      headlessRef.current = undefined;
      initialized.current = false;
      replayReady.current = false;
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
    (language: string = "plaintext", position: "start" | "end" = "start") => {
      updateManifest((prev) => addBlockToManifest(prev, language, position));
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

  const updateBlockLayout = useCallback(
    (blockId: string, layout: BlockLayout) => {
      updateManifest((prev) =>
        updateBlockLayoutInManifest(prev, blockId, layout),
      );
    },
    [updateManifest],
  );

  const migrateLegacyLayout = useCallback(
    (legacy: Record<string, BlockLayout>) => {
      updateManifest((prev) => migrateLegacyLayoutInManifest(prev, legacy));
    },
    [updateManifest],
  );

  const moveBlock = useCallback(
    (blockId: string, direction: MoveDirection) => {
      updateManifest((prev) => moveBlockInManifest(prev, blockId, direction));
    },
    [updateManifest],
  );

  const moveBlockBefore = useCallback(
    (blockId: string, beforeId: string | null) => {
      updateManifest((prev) =>
        moveBlockBeforeInManifest(prev, blockId, beforeId),
      );
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
    updateBlockLayout,
    migrateLegacyLayout,
    moveBlock,
    moveBlockBefore,
  };
}
