import {
  Box,
  Flex,
  HStack,
  Icon,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Portal,
  Select,
  Text,
  useToast,
} from "@chakra-ui/react";
import Editor from "@monaco-editor/react";
import debounce from "lodash.debounce";
import { editor } from "monaco-editor/esm/vs/editor/editor.api";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  VscArrowDown,
  VscArrowUp,
  VscChevronDown,
  VscChevronRight,
  VscCircleFilled,
  VscClose,
  VscCloudDownload,
  VscCopy,
  VscEllipsis,
  VscGripper,
  VscTriangleDown,
  VscTriangleUp,
} from "react-icons/vsc";

import type { BlockInfo, BlockLayout, MoveDirection } from "./BlockManifest";
import ImeInput from "./ImeInput";
import languages from "./languages.json";
import {
  DEFAULT_BLOCK_BODY_HEIGHT,
  doesFoldRecordDiffer,
  shouldPersistSingleDocFolds,
} from "./manifestOps";
import {
  attachHeadingEnter,
  isFoldingImeHeld,
  observeFoldChanges,
  readFoldRecord,
  readFoldRecordSync,
  restoreFoldRecord,
} from "./markdownFolding";
import Rustpad, { UserInfo } from "./rustpad";
import { flushFoldMementoOnUnmount } from "./singleDocFolds";
import { getWsUri } from "./useHash";

type BlockEditorProps = {
  pageId: string;
  block: BlockInfo;
  single: boolean;
  active: boolean;
  singleBodyHeight: number;
  onClientChange: (blockId: string, client?: Rustpad) => void;
  darkMode: boolean;
  wordWrap: boolean;
  initialContent?: string;
  onUpdateBlock: (
    patch: Partial<Pick<BlockInfo, "title" | "language">>,
  ) => void;
  onUpdateLayout: (layout: BlockLayout) => void;
  onRemoveBlock: () => void;
  onMoveBlock: (direction: MoveDirection) => void;
  onContentChange: (content: string) => void;
  onEdited?: () => void;
  onCopyBlock: () => void;
  onExportBlock: () => void;
  onDragHandlePointerDown: (event: React.PointerEvent) => void;
};

function BlockEditor({
  pageId,
  block,
  single,
  active,
  singleBodyHeight,
  onClientChange,
  darkMode,
  wordWrap,
  initialContent,
  onUpdateBlock,
  onUpdateLayout,
  onRemoveBlock,
  onMoveBlock,
  onContentChange,
  onEdited,
  onCopyBlock,
  onExportBlock,
  onDragHandlePointerDown,
}: BlockEditorProps) {
  const collapsed = block.collapsed ?? false;
  const toast = useToast();
  const wantsBodyVisible = active && (single || !collapsed);
  const [bodyVisible, setBodyVisible] = useState(wantsBodyVisible);
  const composingRef = useRef(false);
  const wantsBodyVisibleRef = useRef(wantsBodyVisible);
  wantsBodyVisibleRef.current = wantsBodyVisible;
  const scrollPositionRef = useRef<editor.INewScrollPosition>();
  const height = block.height ?? DEFAULT_BLOCK_BODY_HEIGHT;
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const [editorInstance, setEditorInstance] =
    useState<editor.IStandaloneCodeEditor>();
  const [contentReady, setContentReady] = useState(false);
  const rustpad = useRef<Rustpad>();
  const [users, setUsers] = useState<Record<number, UserInfo>>({});
  // Keep the latest onContentChange in a ref so the connection effect below does
  // not depend on it. The parent passes a fresh inline callback every render;
  // depending on it would dispose+recreate the Rustpad connection (and reset the
  // model) on every parent render.
  const onContentChangeRef = useRef(onContentChange);
  const onEditedRef = useRef(onEdited);
  const onUpdateLayoutRef = useRef(onUpdateLayout);
  const foldsRef = useRef(block.folds);
  const lastSavedFoldsRef = useRef(block.folds);
  const lastGoodFoldsRef = useRef<unknown>(undefined);
  const restoringFoldsRef = useRef(false);
  useEffect(() => {
    onContentChangeRef.current = onContentChange;
    onEditedRef.current = onEdited;
  });
  onUpdateLayoutRef.current = onUpdateLayout;
  foldsRef.current = block.folds;

  const docId = `page:${pageId}:block:${block.id}`;

  useEffect(() => {
    setContentReady(false);
    if (editorInstance?.getModel()) {
      const model = editorInstance.getModel()!;
      // Connect with an empty model and let the server History sync the real
      // document first; only seed the local snapshot content via onReady when
      // the server doc is empty. Pre-filling before connecting made the server
      // History stack on top of the seed -> content doubled (same root cause as
      // the SingleDocView fix).
      const seed = initialContent;
      model.setValue("");
      model.setEOL(0);
      onContentChangeRef.current(model.getValue());
      const client = new Rustpad({
        uri: getWsUri(docId),
        editor: editorInstance,
        onConnected: () => setConnection("connected"),
        onReady: () => {
          if (seed && model.getValue() === "") {
            const range = model.getFullModelRange();
            model.pushEditOperations(
              editorInstance.getSelections(),
              [{ range, text: seed }],
              () => null,
            );
          }
          setContentReady(true);
        },
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => setConnection("desynchronized"),
        onChangeUsers: setUsers,
      });
      rustpad.current = client;
      onClientChange(block.id, client);
      return () => {
        onClientChange(block.id);
        void client.dispose().catch((error: unknown) => {
          console.error("Failed to close block connection", error);
          toast({
            title: "Block sync failed",
            description:
              error instanceof Error
                ? error.message
                : "Pending edits could not be confirmed.",
            status: "error",
            duration: null,
            isClosable: true,
          });
        });
        rustpad.current = undefined;
        setContentReady(false);
      };
    }
  }, [docId, editorInstance, initialContent, block.id, onClientChange, toast]);

  useEffect(() => {
    if (!editorInstance) return;
    const start = editorInstance.onDidCompositionStart(() => {
      composingRef.current = true;
    });
    const end = editorInstance.onDidCompositionEnd(() => {
      composingRef.current = false;
      setBodyVisible(wantsBodyVisibleRef.current);
    });
    return () => {
      start.dispose();
      end.dispose();
    };
  }, [editorInstance]);

  useLayoutEffect(() => {
    if (!wantsBodyVisible && composingRef.current) {
      const input = editorInstance
        ?.getDomNode()
        ?.querySelector<HTMLElement>("textarea, [contenteditable=true]");
      // Native blur commits composition; keep the body visible until Monaco ends it.
      input?.blur();
      return;
    }
    setBodyVisible(wantsBodyVisible);
  }, [editorInstance, wantsBodyVisible]);

  useLayoutEffect(() => {
    if (!editorInstance) return;
    if (bodyVisible) {
      editorInstance.layout();
      if (scrollPositionRef.current)
        editorInstance.setScrollPosition(scrollPositionRef.current);
    }
    return () => {
      if (bodyVisible && editorInstance.getModel()) {
        scrollPositionRef.current = {
          scrollTop: editorInstance.getScrollTop(),
          scrollLeft: editorInstance.getScrollLeft(),
        };
      }
    };
  }, [bodyVisible, editorInstance, single, singleBodyHeight, height]);

  useEffect(() => {
    editorInstance?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [editorInstance, wordWrap]);

  useEffect(() => {
    if (!editorInstance) return;
    onContentChangeRef.current(editorInstance.getValue());
    const disposable = editorInstance.onDidChangeModelContent((event) => {
      onContentChangeRef.current(editorInstance.getValue());
      if (!event.isFlush && editorInstance.hasTextFocus()) {
        onEditedRef.current?.();
      }
    });
    return () => disposable.dispose();
  }, [editorInstance]);

  useEffect(() => {
    if (!editorInstance || !contentReady) return;

    let cancelled = false;
    restoringFoldsRef.current = true;
    lastGoodFoldsRef.current = undefined;
    const restoreAbort = new AbortController();
    const restoreVersion = editorInstance.getModel()?.getVersionId();

    const persist = debounce(() => {
      if (cancelled || restoringFoldsRef.current) return;
      if (isFoldingImeHeld(editorInstance)) return;
      void readFoldRecord(editorInstance).then((next) => {
        if (cancelled || restoringFoldsRef.current) return;
        if (isFoldingImeHeld(editorInstance)) return;
        if (!editorInstance.getModel()) return;
        if (
          !shouldPersistSingleDocFolds(
            next,
            lastSavedFoldsRef.current,
            restoringFoldsRef.current,
          )
        ) {
          return;
        }
        lastSavedFoldsRef.current = next;
        onUpdateLayoutRef.current({ folds: next });
      });
    }, 200);

    const foldChanges = observeFoldChanges(editorInstance, () => {
      if (isFoldingImeHeld(editorInstance)) return;
      const live = readFoldRecordSync(editorInstance);
      if (live !== undefined) lastGoodFoldsRef.current = live;
      persist();
    });

    void restoreFoldRecord(
      editorInstance,
      foldsRef.current,
      restoreAbort.signal,
    ).finally(() => {
      if (!cancelled) {
        restoringFoldsRef.current = false;
        if (editorInstance.getModel()?.getVersionId() !== restoreVersion)
          persist();
        else persist.cancel();
      }
    });

    return () => {
      cancelled = true;
      restoreAbort.abort();
      const restoring = restoringFoldsRef.current;
      foldChanges.dispose();
      const next = flushFoldMementoOnUnmount(
        persist,
        editorInstance.getModel()?.getLanguageId(),
        block.language,
        readFoldRecordSync(editorInstance),
        lastGoodFoldsRef.current,
      );
      if (
        shouldPersistSingleDocFolds(next, lastSavedFoldsRef.current, restoring)
      ) {
        lastSavedFoldsRef.current = next;
        onUpdateLayoutRef.current({ folds: next });
      }
      restoringFoldsRef.current = false;
    };
  }, [block.language, contentReady, editorInstance]);

  useEffect(() => {
    if (!editorInstance || !contentReady) return;
    if (!doesFoldRecordDiffer(block.folds, lastSavedFoldsRef.current)) {
      lastSavedFoldsRef.current = block.folds;
      return;
    }
    lastSavedFoldsRef.current = block.folds;
    const restoreAbort = new AbortController();
    restoringFoldsRef.current = true;
    void restoreFoldRecord(
      editorInstance,
      block.folds,
      restoreAbort.signal,
    ).finally(() => {
      if (!restoreAbort.signal.aborted) restoringFoldsRef.current = false;
    });
    return () => {
      restoreAbort.abort();
    };
  }, [block.folds, contentReady, editorInstance]);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const pointerId = e.pointerId;
      e.currentTarget.setPointerCapture(pointerId);
      const startY = e.clientY;
      const startHeight = height;
      let lastHeight = startHeight;
      document.body.style.userSelect = "none";
      function onMove(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return;
        lastHeight = Math.min(
          1200,
          Math.max(120, startHeight + ev.clientY - startY),
        );
        setDragHeight(lastHeight);
      }
      function onUp(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return;
        document.body.style.userSelect = "";
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        setDragHeight(null);
        onUpdateLayout({ height: lastHeight });
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [height, onUpdateLayout],
  );

  const connectionColor = {
    connected: "green.500",
    disconnected: "orange.500",
    desynchronized: "red.500",
  }[connection];

  const userCount = Object.keys(users).length;
  const menuItemBg = darkMode ? "#2d2d2d" : "white";
  const menuItemActive = { bgColor: darkMode ? "#3a3a3a" : "gray.100" };

  return (
    <Box
      data-block-panel={block.id}
      visibility={!active && !bodyVisible ? "hidden" : "visible"}
      pointerEvents={active || bodyVisible ? "auto" : "none"}
      position="relative"
      border="1px solid"
      borderColor={darkMode ? "#444" : "#ddd"}
      borderRadius="md"
      minW={0}
      overflow="hidden"
    >
      <Flex
        h={8}
        px={2}
        align="center"
        bgColor={darkMode ? "#2d2d2d" : "#f0f0f0"}
        borderBottom={single || !collapsed ? "1px solid" : "none"}
        borderColor={darkMode ? "#444" : "#ddd"}
        gap={1}
        minW={0}
        overflow="hidden"
      >
        <IconButton
          aria-label="Reorder block"
          icon={<Icon as={VscGripper} />}
          size="xs"
          variant="ghost"
          flexShrink={0}
          cursor={single ? "default" : "grab"}
          style={{ touchAction: single ? undefined : "none" }}
          onPointerDown={(event) => {
            if (single || event.button !== 0) return;
            event.preventDefault();
            onDragHandlePointerDown(event);
          }}
        />
        <IconButton
          aria-label="Toggle block"
          icon={<Icon as={collapsed ? VscChevronRight : VscChevronDown} />}
          size="xs"
          variant="ghost"
          flexShrink={0}
          onClick={() => onUpdateLayout({ collapsed: !collapsed })}
        />

        <Icon
          as={VscCircleFilled}
          color={connectionColor}
          boxSize={2}
          flexShrink={0}
        />

        <ImeInput
          size="xs"
          variant="unstyled"
          fontWeight="semibold"
          fontSize="sm"
          value={block.title}
          onValueChange={(title) => onUpdateBlock({ title })}
          flex="1 1 0"
          minW={0}
          maxW="200px"
          overflow="hidden"
          px={1}
        />

        <Select
          size="xs"
          variant="unstyled"
          fontSize="xs"
          value={block.language}
          onChange={(e) => onUpdateBlock({ language: e.target.value })}
          flex="0 1 7rem"
          minW={0}
          maxW="120px"
          overflow="hidden"
          color={darkMode ? "#999" : "#666"}
        >
          {languages.map((lang) => (
            <option key={lang} value={lang} style={{ color: "black" }}>
              {lang}
            </option>
          ))}
        </Select>

        {userCount > 0 && (
          <Text
            fontSize="xs"
            color={darkMode ? "#888" : "#999"}
            ml={1}
            flexShrink={0}
          >
            +{userCount}
          </Text>
        )}

        <HStack spacing={0} ml="auto" flexShrink={0}>
          <IconButton
            aria-label="Copy block content"
            icon={<Icon as={VscCopy} />}
            size="xs"
            variant="ghost"
            onClick={onCopyBlock}
          />
          <IconButton
            aria-label="Export block"
            icon={<Icon as={VscCloudDownload} />}
            size="xs"
            variant="ghost"
            onClick={onExportBlock}
          />
          <Menu>
            <MenuButton
              as={IconButton}
              aria-label="More block actions"
              icon={<Icon as={VscEllipsis} />}
              size="xs"
              variant="ghost"
            />
            <Portal>
              <MenuList
                fontSize="sm"
                minW="12rem"
                bgColor={darkMode ? "#2d2d2d" : "white"}
                borderColor={darkMode ? "#444" : "gray.200"}
                color={darkMode ? "#cbcaca" : "inherit"}
              >
                <MenuItem
                  icon={<Icon as={VscTriangleUp} />}
                  bgColor={menuItemBg}
                  _hover={menuItemActive}
                  _focus={menuItemActive}
                  onClick={() => onMoveBlock("up")}
                >
                  Move Up
                </MenuItem>
                <MenuItem
                  icon={<Icon as={VscTriangleDown} />}
                  bgColor={menuItemBg}
                  _hover={menuItemActive}
                  _focus={menuItemActive}
                  onClick={() => onMoveBlock("down")}
                >
                  Move Down
                </MenuItem>
                <MenuItem
                  icon={<Icon as={VscArrowUp} />}
                  bgColor={menuItemBg}
                  _hover={menuItemActive}
                  _focus={menuItemActive}
                  onClick={() => onMoveBlock("top")}
                >
                  Move to Top
                </MenuItem>
                <MenuItem
                  icon={<Icon as={VscArrowDown} />}
                  bgColor={menuItemBg}
                  _hover={menuItemActive}
                  _focus={menuItemActive}
                  onClick={() => onMoveBlock("bottom")}
                >
                  Move to Bottom
                </MenuItem>
              </MenuList>
            </Portal>
          </Menu>
          <IconButton
            aria-label="Remove block"
            icon={<Icon as={VscClose} />}
            size="xs"
            variant="ghost"
            color="red.400"
            onClick={onRemoveBlock}
          />
        </HStack>
      </Flex>

      <Box
        data-block-body={block.id}
        h={`${single ? singleBodyHeight : (dragHeight ?? height)}px`}
        w="100%"
        position={!single && !bodyVisible ? "absolute" : "relative"}
        visibility={bodyVisible ? "visible" : "hidden"}
      >
        <Editor
          theme={darkMode ? "vs-dark" : "vs"}
          language={block.language}
          path={`rustpad-block://${pageId}/${block.id}`}
          options={{
            automaticLayout: true,
            fontSize: 13,
            scrollBeyondLastLine: false,
            showFoldingControls: "always",
          }}
          onMount={(ed, monaco) => {
            attachHeadingEnter(ed, monaco);
            setEditorInstance(ed);
          }}
        />
      </Box>
      {!single && !collapsed && (
        <Box
          h="6px"
          cursor="ns-resize"
          bgColor={darkMode ? "#2d2d2d" : "#f0f0f0"}
          borderTop="1px solid"
          borderColor={darkMode ? "#444" : "#ddd"}
          _hover={{ bgColor: darkMode ? "#3a3a3a" : "#e2e2e2" }}
          style={{ touchAction: "none" }}
          onPointerDown={startResize}
          title="Drag to resize"
        />
      )}
    </Box>
  );
}

export default BlockEditor;
