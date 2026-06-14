import {
  Box,
  Flex,
  HStack,
  Icon,
  IconButton,
  Input,
  Select,
  Text,
} from "@chakra-ui/react";
import Editor from "@monaco-editor/react";
import { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  VscChevronDown,
  VscChevronRight,
  VscCircleFilled,
  VscClose,
  VscTriangleDown,
  VscTriangleUp,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import type { BlockInfo } from "./BlockManifest";
import languages from "./languages.json";
import Rustpad, { UserInfo } from "./rustpad";
import { getWsUri } from "./useHash";

type BlockEditorProps = {
  pageId: string;
  block: BlockInfo;
  darkMode: boolean;
  wordWrap: boolean;
  initialContent?: string;
  onUpdateBlock: (patch: Partial<Pick<BlockInfo, "title" | "language">>) => void;
  onRemoveBlock: () => void;
  onMoveBlock: (direction: "up" | "down") => void;
  onContentChange: (content: string) => void;
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
      model.setValue(initialContent ?? "");
      model.setEOL(0);
      onContentChange(model.getValue());
      rustpad.current = new Rustpad({
        uri: getWsUri(docId),
        editor: editorInstance,
        onConnected: () => setConnection("connected"),
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => setConnection("desynchronized"),
        onChangeUsers: setUsers,
      });
      return () => {
        rustpad.current?.dispose();
        rustpad.current = undefined;
      };
    }
  }, [docId, editorInstance, collapsed, initialContent, onContentChange]);

  useEffect(() => {
    editorInstance?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [editorInstance, wordWrap]);

  useEffect(() => {
    if (!editorInstance) return;
    onContentChange(editorInstance.getValue());
    return editorInstance.onDidChangeModelContent(() => {
      onContentChange(editorInstance.getValue());
    }).dispose;
  }, [editorInstance, onContentChange]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      document.body.style.userSelect = "none";
      function onMove(ev: MouseEvent) {
        const next = Math.min(
          1200,
          Math.max(120, startHeight + ev.clientY - startY),
        );
        setHeight(next);
      }
      function onUp() {
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [height, setHeight],
  );

  const connectionColor = {
    connected: "green.500",
    disconnected: "orange.500",
    desynchronized: "red.500",
  }[connection];

  const userCount = Object.keys(users).length;

  return (
    <Box
      border="1px solid"
      borderColor={darkMode ? "#444" : "#ddd"}
      borderRadius="md"
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
      >
        <IconButton
          aria-label="Toggle block"
          icon={<Icon as={collapsed ? VscChevronRight : VscChevronDown} />}
          size="xs"
          variant="ghost"
          onClick={() => setCollapsed(!collapsed)}
        />

        <Icon as={VscCircleFilled} color={connectionColor} boxSize={2} />

        <Input
          size="xs"
          variant="unstyled"
          fontWeight="semibold"
          fontSize="sm"
          value={block.title}
          onChange={(e) => onUpdateBlock({ title: e.target.value })}
          maxW="200px"
          px={1}
        />

        <Select
          size="xs"
          variant="unstyled"
          fontSize="xs"
          value={block.language}
          onChange={(e) => onUpdateBlock({ language: e.target.value })}
          maxW="120px"
          color={darkMode ? "#999" : "#666"}
        >
          {languages.map((lang) => (
            <option key={lang} value={lang} style={{ color: "black" }}>
              {lang}
            </option>
          ))}
        </Select>

        {userCount > 0 && (
          <Text fontSize="xs" color={darkMode ? "#888" : "#999"} ml={1}>
            +{userCount}
          </Text>
        )}

        <HStack spacing={0} ml="auto">
          <IconButton
            aria-label="Move up"
            icon={<Icon as={VscTriangleUp} />}
            size="xs"
            variant="ghost"
            onClick={() => onMoveBlock("up")}
          />
          <IconButton
            aria-label="Move down"
            icon={<Icon as={VscTriangleDown} />}
            size="xs"
            variant="ghost"
            onClick={() => onMoveBlock("down")}
          />
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
              options={{
                automaticLayout: true,
                fontSize: 13,
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
            onMouseDown={startResize}
            title="Drag to resize"
          />
        </>
      )}
    </Box>
  );
}

export default BlockEditor;
