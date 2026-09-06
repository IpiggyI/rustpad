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
} from "@chakra-ui/react";
import Editor from "@monaco-editor/react";
import { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useCallback, useEffect, useRef, useState } from "react";
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
  VscTriangleDown,
  VscTriangleUp,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import type { BlockInfo, MoveDirection } from "./BlockManifest";
import ImeInput from "./ImeInput";
import languages from "./languages.json";
import Rustpad, { UserInfo } from "./rustpad";
import { getWsUri } from "./useHash";

type BlockEditorProps = {
  pageId: string;
  block: BlockInfo;
  darkMode: boolean;
  wordWrap: boolean;
  initialContent?: string;
  onUpdateBlock: (
    patch: Partial<Pick<BlockInfo, "title" | "language">>,
  ) => void;
  onRemoveBlock: () => void;
  onMoveBlock: (direction: MoveDirection) => void;
  onContentChange: (content: string) => void;
  onCopyBlock: () => void;
  onExportBlock: () => void;
};

function BlockEditor({
  pageId,
  block,
  darkMode,
  wordWrap,
  initialContent,
  onUpdateBlock,
  onRemoveBlock,
  onMoveBlock,
  onContentChange,
  onCopyBlock,
  onExportBlock,
}: BlockEditorProps) {
  const storageKey = `block-collapsed:${pageId}:${block.id}`;
  const [collapsed, setCollapsed] = useLocalStorageState(storageKey, {
    defaultValue: false,
  });
  const heightKey = `block-height:${pageId}:${block.id}`;
  const [height, setHeight] = useLocalStorageState(heightKey, {
    defaultValue: 300,
  });
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const [editorInstance, setEditorInstance] =
    useState<editor.IStandaloneCodeEditor>();
  const rustpad = useRef<Rustpad>();
  const [users, setUsers] = useState<Record<number, UserInfo>>({});
  // Keep the latest onContentChange in a ref so the connection effect below does
  // not depend on it. The parent passes a fresh inline callback every render;
  // depending on it would dispose+recreate the Rustpad connection (and reset the
  // model) on every parent render.
  const onContentChangeRef = useRef(onContentChange);
  useEffect(() => {
    onContentChangeRef.current = onContentChange;
  });

  const docId = `page:${pageId}:block:${block.id}`;

  useEffect(() => {
    if (collapsed) {
      rustpad.current?.dispose();
      rustpad.current = undefined;
      setConnection("disconnected");
    }
  }, [collapsed]);

  useEffect(() => {
    if (editorInstance?.getModel() && !collapsed) {
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
      rustpad.current = new Rustpad({
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
        },
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => setConnection("desynchronized"),
        onChangeUsers: setUsers,
      });
      return () => {
        rustpad.current?.dispose();
        rustpad.current = undefined;
      };
    }
  }, [docId, editorInstance, collapsed, initialContent]);

  useEffect(() => {
    editorInstance?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [editorInstance, wordWrap]);

  useEffect(() => {
    if (!editorInstance) return;
    onContentChangeRef.current(editorInstance.getValue());
    const disposable = editorInstance.onDidChangeModelContent(() => {
      onContentChangeRef.current(editorInstance.getValue());
    });
    return () => disposable.dispose();
  }, [editorInstance]);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const pointerId = e.pointerId;
      e.currentTarget.setPointerCapture(pointerId);
      const startY = e.clientY;
      const startHeight = height;
      document.body.style.userSelect = "none";
      function onMove(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return;
        const next = Math.min(
          1200,
          Math.max(120, startHeight + ev.clientY - startY),
        );
        setHeight(next);
      }
      function onUp(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return;
        document.body.style.userSelect = "";
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [height, setHeight],
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
        borderBottom={collapsed ? "none" : "1px solid"}
        borderColor={darkMode ? "#444" : "#ddd"}
        gap={1}
        minW={0}
        overflow="hidden"
      >
        <IconButton
          aria-label="Toggle block"
          icon={<Icon as={collapsed ? VscChevronRight : VscChevronDown} />}
          size="xs"
          variant="ghost"
          flexShrink={0}
          onClick={() => setCollapsed(!collapsed)}
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

      {!collapsed && (
        <>
          <Box h={`${height}px`}>
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
              onMount={(ed) => setEditorInstance(ed)}
            />
          </Box>
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
        </>
      )}
    </Box>
  );
}

export default BlockEditor;
