import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Box,
  Button,
  Container,
  Flex,
  HStack,
  Heading,
  Icon,
  IconButton,
  Input,
  InputGroup,
  InputRightElement,
  Select,
  Stack,
  Switch,
  Text,
  VStack,
  useToast,
} from "@chakra-ui/react";
import { Reorder, useDragControls } from "framer-motion";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  VscAdd,
  VscClose,
  VscCloudDownload,
  VscCopy,
  VscLayoutSidebarLeft,
  VscLayoutSidebarLeftOff,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import BlockEditor from "./BlockEditor";
import {
  type BlockInfo,
  type BlockLayout,
  Manifest,
  migrateLegacyLayout,
  useManifest,
} from "./BlockManifest";
import ConnectionStatus from "./ConnectionStatus";
import Footer from "./Footer";
import ImeInput from "./ImeInput";
import { loadBlockSnapshot, saveBlockSnapshot } from "./blockModeSync";
import {
  type BlockPresentation,
  loadBlockPresentation,
  saveBlockPresentation,
} from "./blockPresentation";
import {
  chooseReplacementBlockId,
  loadCurrentBlockId,
  resolveCurrentBlockId,
  saveCurrentBlockId,
} from "./currentBlock";
import languageExtensions from "./extensions";
import languages from "./languages.json";
import type Rustpad from "./rustpad";
import RustpadHeadless from "./rustpad-headless";
import { getWsUri } from "./useHash";

const exportTimeoutMs = 10000;

function readLegacyNumber(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  } catch {
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function readLegacyBoolean(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw);
    if (typeof value === "boolean") return value;
  } catch {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  return undefined;
}

function collectLegacyLayouts(
  pageId: string,
  blockIds: readonly string[],
): Record<string, BlockLayout> {
  const legacy: Record<string, BlockLayout> = {};
  for (const blockId of blockIds) {
    let rawHeight: string | null = null;
    let rawCollapsed: string | null = null;
    try {
      rawHeight = window.localStorage.getItem(
        `block-height:${pageId}:${blockId}`,
      );
      rawCollapsed = window.localStorage.getItem(
        `block-collapsed:${pageId}:${blockId}`,
      );
    } catch {
      continue;
    }
    const layout: BlockLayout = {};
    const height = readLegacyNumber(rawHeight);
    const collapsed = readLegacyBoolean(rawCollapsed);
    if (height !== undefined) layout.height = height;
    if (collapsed !== undefined) layout.collapsed = collapsed;
    if (layout.height !== undefined || layout.collapsed !== undefined) {
      legacy[blockId] = layout;
    }
  }
  return legacy;
}

function clearLegacyLayout(pageId: string, blockId: string): void {
  try {
    window.localStorage.removeItem(`block-height:${pageId}:${blockId}`);
    window.localStorage.removeItem(`block-collapsed:${pageId}:${blockId}`);
  } catch {
    // leftover cleanup must never interrupt editing
  }
}

function stopFieldBubble(event: { stopPropagation(): void }) {
  event.stopPropagation();
}

function DeleteBlockConfirm({
  isOpen,
  blockTitle,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  blockTitle: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog
      isOpen={isOpen}
      leastDestructiveRef={cancelRef}
      onClose={onClose}
    >
      <AlertDialogOverlay>
        <AlertDialogContent data-delete-block-dialog="">
          <AlertDialogHeader>Delete block</AlertDialogHeader>

          <AlertDialogBody>
            Delete the block &quot;{blockTitle}&quot;?
          </AlertDialogBody>

          <AlertDialogFooter>
            <Button
              ref={cancelRef}
              data-cancel-delete-block=""
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              colorScheme="red"
              data-confirm-delete-block=""
              onClick={onConfirm}
              ml={3}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialog>
  );
}

function SidebarBlockRow({
  block,
  isCurrent,
  darkMode,
  autoFocusName,
  onSelect,
  onUpdateBlock,
  onNameBlur,
  onRemove,
}: {
  block: BlockInfo;
  isCurrent: boolean;
  darkMode: boolean;
  autoFocusName: boolean;
  onSelect: () => void;
  onUpdateBlock: (
    patch: Partial<Pick<BlockInfo, "title" | "language">>,
  ) => void;
  onNameBlur: () => void;
  onRemove: () => void;
}) {
  return (
    <Flex
      data-block-row={block.id}
      align="center"
      gap={1}
      minH={8}
      px={1}
      borderRadius="md"
      bgColor={isCurrent ? (darkMode ? "#37373d" : "gray.200") : "transparent"}
      _hover={{
        bgColor: darkMode ? "#323232" : "gray.100",
      }}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("input, select, textarea")
        ) {
          return;
        }
        onSelect();
      }}
    >
      <Button
        data-block-id={block.id}
        aria-current={isCurrent ? "true" : undefined}
        aria-label={block.title}
        variant="ghost"
        size="sm"
        minW={6}
        h={7}
        px={1}
        flexShrink={0}
        fontWeight={isCurrent ? "semibold" : "normal"}
        onClick={onSelect}
      >
        {isCurrent ? "●" : "○"}
      </Button>
      <ImeInput
        data-block-name={block.id}
        aria-label="Block name"
        size="sm"
        variant="unstyled"
        fontSize="sm"
        value={block.title}
        onValueChange={(title) => onUpdateBlock({ title })}
        flex="1 1 0"
        minW={0}
        px={1}
        autoFocus={autoFocusName}
        onPointerDown={stopFieldBubble}
        onMouseDown={stopFieldBubble}
        onClick={stopFieldBubble}
        onFocus={(event) => {
          if (autoFocusName) event.currentTarget.select();
        }}
        onBlur={onNameBlur}
      />
      <Select
        data-block-language={block.id}
        aria-label="Block language"
        size="xs"
        variant="unstyled"
        fontSize="xs"
        value={block.language}
        onChange={(event) => onUpdateBlock({ language: event.target.value })}
        flex="0 0 6.5rem"
        minW={0}
        maxW="6.5rem"
        color={darkMode ? "#999" : "#666"}
        onPointerDown={stopFieldBubble}
        onMouseDown={stopFieldBubble}
        onClick={stopFieldBubble}
      >
        {languages.map((lang) => (
          <option key={lang} value={lang} style={{ color: "black" }}>
            {lang}
          </option>
        ))}
      </Select>
      <IconButton
        data-sidebar-remove-block={block.id}
        aria-label="Remove block"
        icon={<Icon as={VscClose} />}
        size="xs"
        variant="ghost"
        color="red.400"
        flexShrink={0}
        onPointerDown={stopFieldBubble}
        onMouseDown={stopFieldBubble}
        onClick={(event) => {
          stopFieldBubble(event);
          onRemove();
        }}
      />
    </Flex>
  );
}

function ReorderableBlock({
  onReorderEnd,
  ...editorProps
}: Omit<ComponentProps<typeof BlockEditor>, "onDragHandlePointerDown"> & {
  onReorderEnd: (blockId: string) => void;
}) {
  const controls = useDragControls();
  const blockId = editorProps.block.id;
  return (
    <Reorder.Item
      as="div"
      value={blockId}
      dragListener={false}
      dragControls={controls}
      layout={editorProps.single ? undefined : "position"}
      initial={false}
      style={{
        position: editorProps.single ? "absolute" : "relative",
        top: editorProps.single ? 0 : undefined,
        width: "100%",
        minWidth: 0,
        pointerEvents: "none",
      }}
      onDragEnd={() => onReorderEnd(blockId)}
    >
      <BlockEditor
        {...editorProps}
        onDragHandlePointerDown={(event) => controls.start(event)}
      />
    </Reorder.Item>
  );
}

function BlockPageView({
  id,
  darkMode,
  onDarkModeChange,
}: {
  id: string;
  darkMode: boolean;
  onDarkModeChange: () => void;
}) {
  const toast = useToast();
  const initialSnapshot = useRef(loadBlockSnapshot(id));
  const initialManifest = useRef<Manifest | undefined>(
    initialSnapshot.current
      ? migrateLegacyLayout(
          {
            version: initialSnapshot.current.version,
            compactHeights: initialSnapshot.current.compactHeights,
            blocks: initialSnapshot.current.blocks.map(
              ({ content, ...block }) => block,
            ),
          },
          collectLegacyLayouts(
            id,
            initialSnapshot.current.blocks.map((block) => block.id),
          ),
        )
      : undefined,
  );
  const initialContentByBlock = useRef<Record<string, string>>(
    initialSnapshot.current
      ? Object.fromEntries(
          initialSnapshot.current.blocks.map((block) => [
            block.id,
            block.content,
          ]),
        )
      : {},
  );
  const {
    manifest,
    connection,
    addBlock,
    addBlockAfter,
    updateTitle,
    removeBlock,
    updateBlock,
    updateBlockLayout,
    migrateLegacyLayout: adoptLegacyLayout,
    moveBlock,
    moveBlockBefore,
    ready: manifestReady,
    unusable: manifestUnusable,
  } = useManifest(id, {
    initialManifest: initialManifest.current,
  });
  const liveBlockContents = useRef<Record<string, string>>({});
  const blockClients = useRef(new Map<string, Rustpad>());
  const registerClient = useCallback((blockId: string, client?: Rustpad) => {
    if (client) blockClients.current.set(blockId, client);
    else blockClients.current.delete(blockId);
  }, []);
  const [presentation, setPresentation] = useState(() =>
    loadBlockPresentation(id),
  );
  const single = presentation === "single";
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [singleBodyHeight, setSingleBodyHeight] = useState(400);
  useEffect(() => {
    setPresentation(loadBlockPresentation(id));
  }, [id]);
  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(() => {
      setSingleBodyHeight(Math.max(120, area.clientHeight - 138));
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  const currentBlockIdRef = useRef<string | null>(null);
  const lastOrderRef = useRef<string[]>([]);
  const lastPageIdRef = useRef<string | null>(null);
  const [currentBlockId, setCurrentBlockId] = useState<string | null>(null);
  const [namingBlockId, setNamingBlockId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const blockIdsKey = manifest.blocks.map((block) => block.id).join(",");
  const legacyLayouts = useMemo(
    () =>
      collectLegacyLayouts(
        id,
        blockIdsKey === "" ? [] : blockIdsKey.split(","),
      ),
    [blockIdsKey, id],
  );
  const visibleManifest = useMemo(
    () => migrateLegacyLayout(manifest, legacyLayouts),
    [legacyLayouts, manifest],
  );
  const blocksRef = useRef(visibleManifest.blocks);
  blocksRef.current = visibleManifest.blocks;
  const dragOrderIdsRef = useRef<string[] | null>(null);
  const snapshotBlocksRef = useRef<Map<string, BlockInfo>>(new Map());
  const [dragOrderIds, setDragOrderIds] = useState<string[] | null>(null);
  const orderIds =
    dragOrderIds ?? visibleManifest.blocks.map((block) => block.id);

  useEffect(() => {
    dragOrderIdsRef.current = null;
    snapshotBlocksRef.current = new Map();
    setDragOrderIds(null);
  }, [id]);

  const commitCurrentBlock = useCallback(
    (next: string | null) => {
      currentBlockIdRef.current = next;
      setCurrentBlockId(next);
      saveCurrentBlockId(id, next);
    },
    [id],
  );

  const selectBlockFromSidebar = useCallback(
    (blockId: string) => {
      commitCurrentBlock(blockId);
      const panel = document.querySelector(
        `[data-block-panel="${CSS.escape(blockId)}"]`,
      );
      panel?.scrollIntoView({ block: "start", inline: "nearest" });
    },
    [commitCurrentBlock],
  );

  const handleSidebarAddBlock = useCallback(() => {
    const createdId = addBlockAfter(currentBlockIdRef.current);
    if (!createdId) return;
    commitCurrentBlock(createdId);
    setNamingBlockId(createdId);
  }, [addBlockAfter, commitCurrentBlock]);

  const requestDeleteBlock = useCallback((block: BlockInfo) => {
    setPendingDelete({ id: block.id, title: block.title });
  }, []);

  const cancelDeleteBlock = useCallback(() => {
    setPendingDelete(null);
  }, []);

  const confirmDeleteBlock = useCallback(() => {
    if (!pendingDelete) return;
    const blockId = pendingDelete.id;
    setPendingDelete(null);
    clearLegacyLayout(id, blockId);
    removeBlock(blockId);
  }, [id, pendingDelete, removeBlock]);

  useEffect(() => {
    if (!currentBlockId) return;
    const frame = requestAnimationFrame(() => {
      const panel = document.querySelector(
        `[data-block-panel="${CSS.escape(currentBlockId)}"]`,
      );
      panel?.scrollIntoView({ block: "start", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentBlockId, presentation]);

  useEffect(() => {
    if (!manifestReady) return;
    const blocks = blocksRef.current;
    const ids = blocks.map((block) => block.id);
    if (lastPageIdRef.current !== id) {
      lastPageIdRef.current = id;
      lastOrderRef.current = [];
      currentBlockIdRef.current = loadCurrentBlockId(id);
    }
    const previous = lastOrderRef.current;
    const candidate = currentBlockIdRef.current;
    const next =
      candidate != null &&
      !ids.includes(candidate) &&
      previous.includes(candidate)
        ? chooseReplacementBlockId(
            previous.map((blockId) => ({ id: blockId })),
            blocks,
            candidate,
          )
        : resolveCurrentBlockId(candidate, blocks);
    lastOrderRef.current = ids;
    currentBlockIdRef.current = next;
    setCurrentBlockId(next);
    if (loadCurrentBlockId(id) !== next) {
      saveCurrentBlockId(id, next);
    }
  }, [blockIdsKey, id, manifestReady]);

  useEffect(() => {
    if (!pendingDelete) return;
    if (!manifest.blocks.some((block) => block.id === pendingDelete.id)) {
      setPendingDelete(null);
    }
  }, [manifest.blocks, pendingDelete]);

  const captureBlockSnapshot = useCallback(() => {
    if (snapshotBlocksRef.current.size === 0) {
      snapshotBlocksRef.current = new Map(
        blocksRef.current.map((block) => [block.id, block]),
      );
    }
  }, []);

  const handleReorder = useCallback(
    (newOrder: string[]) => {
      captureBlockSnapshot();
      dragOrderIdsRef.current = newOrder;
      setDragOrderIds(newOrder);
    },
    [captureBlockSnapshot],
  );

  const handleReorderEnd = useCallback(
    (blockId: string) => {
      const ids = dragOrderIdsRef.current;
      dragOrderIdsRef.current = null;
      snapshotBlocksRef.current = new Map();
      setDragOrderIds(null);
      if (!ids) return;
      const index = ids.indexOf(blockId);
      if (index < 0) return;
      const beforeId = index < ids.length - 1 ? ids[index + 1] : null;
      moveBlockBefore(blockId, beforeId);
    },
    [moveBlockBefore],
  );

  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState(
    "sidebarCollapsed",
    { defaultValue: () => window.innerWidth < 480 },
  );
  const [wordWrap, setWordWrap] = useLocalStorageState("wordWrap", {
    defaultValue: false,
  });
  const [documentTitle, setDocumentTitle] = useLocalStorageState(
    `documentTitle:page:${id}`,
    { defaultValue: "" },
  );

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  // Update browser tab title
  useEffect(() => {
    const title = manifest.title ?? documentTitle;
    document.title = title ? `${title} - Rustpad` : "Rustpad";
  }, [documentTitle, manifest.title]);

  useEffect(() => {
    if (manifest.title !== undefined) {
      setDocumentTitle(manifest.title);
    }
  }, [manifest.title, setDocumentTitle]);

  function handleDocumentTitleChange(title: string) {
    if (!manifestReady) return;
    setDocumentTitle(title);
    updateTitle(title);
  }

  const rememberBlockContent = useCallback(
    (blockId: string, content: string) => {
      liveBlockContents.current[blockId] = content;
      const nextContents = { ...liveBlockContents.current, [blockId]: content };
      saveBlockSnapshot(id, {
        version: visibleManifest.version,
        compactHeights: visibleManifest.compactHeights,
        blocks: visibleManifest.blocks.map((block) => ({
          ...block,
          content:
            nextContents[block.id] ??
            initialContentByBlock.current[block.id] ??
            "",
        })),
      });
    },
    [id, visibleManifest],
  );

  useEffect(() => {
    if (!manifestReady) return;
    adoptLegacyLayout(legacyLayouts);
  }, [adoptLegacyLayout, id, legacyLayouts, manifestReady]);

  useEffect(() => {
    if (manifestReady) {
      saveCurrentSnapshot();
    }
  }, [id, visibleManifest, manifestReady]);

  function saveCurrentSnapshot(nextContents = liveBlockContents.current) {
    const snapshot = {
      version: visibleManifest.version,
      compactHeights: visibleManifest.compactHeights,
      blocks: visibleManifest.blocks.map((block) => ({
        ...block,
        content:
          nextContents[block.id] ??
          initialContentByBlock.current[block.id] ??
          "",
      })),
    };
    saveBlockSnapshot(id, snapshot);
    return snapshot;
  }

  async function resolveBlockContent(
    blockId: string,
    blockTitle: string,
  ): Promise<string> {
    const client = blockClients.current.get(blockId);
    if (!client) throw new Error(`Block is not ready: ${blockTitle}`);
    await client.waitForSync();

    return new Promise<string>((resolve, reject) => {
      let finished = false;
      const docId = `page:${id}:block:${blockId}`;
      const headless = new RustpadHeadless({
        uri: getWsUri(docId),
        onContentReady: (content) => finish(content),
        onDisconnected: () => fail(),
        onDesynchronized: () => fail(),
      });
      const timeoutId = window.setTimeout(() => fail(), exportTimeoutMs);

      function finish(content: string) {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeoutId);
        void headless.dispose();
        resolve(content);
      }

      function fail() {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeoutId);
        void headless.dispose();
        reject(new Error(`Failed to read block: ${blockTitle}`));
      }
    });
  }

  function handleBlockModeChange() {
    if (manifestReady) {
      saveCurrentSnapshot();
    }
    window.location.hash = id;
  }

  const documentUrl = `${window.location.origin}/#page:${id}`;

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(documentUrl);
      toast({
        title: "Copied!",
        description: "Link copied to clipboard",
        status: "success",
        duration: 2000,
        isClosable: true,
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard access was denied by the browser.",
        status: "error",
        duration: 3000,
        isClosable: true,
      });
    }
  }

  async function handleCopyAll() {
    if (!manifestReady || manifest.blocks.length === 0) return;
    try {
      const contents = await Promise.all(
        manifest.blocks.map((b) => resolveBlockContent(b.id, b.title)),
      );
      await navigator.clipboard.writeText(contents.join("\n\n"));
      toast({
        title: "Copied!",
        description: "All blocks copied to clipboard",
        status: "success",
        duration: 2000,
        isClosable: true,
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description:
          error instanceof Error
            ? error.message
            : "Could not read block contents.",
        status: "error",
        duration: 3000,
        isClosable: true,
      });
    }
  }

  async function handleCopyBlock(blockId: string, blockTitle: string) {
    try {
      const content = await resolveBlockContent(blockId, blockTitle);
      await navigator.clipboard.writeText(content);
      toast({
        title: "Copied!",
        description: `"${blockTitle}" copied to clipboard`,
        status: "success",
        duration: 2000,
        isClosable: true,
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description:
          error instanceof Error
            ? error.message
            : "Could not read block content.",
        status: "error",
        duration: 3000,
        isClosable: true,
      });
    }
  }

  async function handleExportBlock(
    blockId: string,
    blockTitle: string,
    language: string,
  ) {
    try {
      const content = await resolveBlockContent(blockId, blockTitle);
      const ext = languageExtensions[language] ?? ".txt";
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${blockTitle}${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        title: "Export failed",
        description:
          error instanceof Error
            ? error.message
            : "Could not read block content.",
        status: "error",
        duration: 3000,
        isClosable: true,
      });
    }
  }

  async function handleExportAll() {
    if (!manifestReady || manifest.blocks.length === 0) return;
    try {
      const contents = await Promise.all(
        manifest.blocks.map((b) => resolveBlockContent(b.id, b.title)),
      );
      const parts: string[] = [];
      manifest.blocks.forEach((block, i) => {
        parts.push(`// === ${block.title} (${block.language}) ===`);
        parts.push(contents[i]);
        parts.push("");
      });
      const merged = parts.join("\n");
      const primaryLang = manifest.blocks[0]?.language ?? "plaintext";
      const ext = languageExtensions[primaryLang] ?? ".txt";
      const blob = new Blob([merged], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${id}${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      toast({
        title: "Exported",
        description: "All blocks were exported.",
        status: "success",
        duration: 2000,
        isClosable: true,
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description:
          error instanceof Error
            ? error.message
            : "Could not read block contents.",
        status: "error",
        duration: 3000,
        isClosable: true,
      });
    }
  }

  return (
    <Flex flex="1 0" minH={0} position="relative">
      {!sidebarCollapsed && (
        <Container
          w={{ base: "3xs", md: "2xs", lg: "xs" }}
          position={{ base: "absolute", sm: "static" }}
          top={{ base: 0, sm: "auto" }}
          bottom={{ base: 0, sm: "auto" }}
          left={{ base: 0, sm: "auto" }}
          zIndex={{ base: 20, sm: "auto" }}
          bgColor={darkMode ? "#252526" : "#f3f3f3"}
          overflowY="auto"
          maxW="full"
          lineHeight={1.4}
          py={4}
        >
          <ConnectionStatus darkMode={darkMode} connection={connection} />

          <Flex justifyContent="space-between" mt={4} mb={1.5} w="full">
            <Heading size="sm">Dark Mode</Heading>
            <Switch isChecked={darkMode} onChange={onDarkModeChange} />
          </Flex>

          <Flex justifyContent="space-between" mt={4} mb={1.5} w="full">
            <Heading size="sm">Word Wrap</Heading>
            <Switch
              isChecked={wordWrap}
              onChange={() => setWordWrap((prev) => !prev)}
            />
          </Flex>

          <Button
            size="sm"
            colorScheme={darkMode ? "whiteAlpha" : "blackAlpha"}
            variant="outline"
            mt={4}
            w="full"
            onClick={handleBlockModeChange}
          >
            Back to Document
          </Button>

          <Heading mt={4} mb={1.5} size="sm">
            Document Title
          </Heading>
          <ImeInput
            size="sm"
            placeholder={id}
            bgColor={darkMode ? "#3c3c3c" : "white"}
            borderColor={darkMode ? "#3c3c3c" : "white"}
            value={documentTitle}
            isDisabled={!manifestReady}
            onValueChange={handleDocumentTitleChange}
          />

          <Heading mt={4} mb={1.5} size="sm">
            Share Link
          </Heading>
          <InputGroup size="sm">
            <Input
              readOnly
              pr="3.5rem"
              variant="outline"
              bgColor={darkMode ? "#3c3c3c" : "white"}
              borderColor={darkMode ? "#3c3c3c" : "white"}
              value={documentUrl}
            />
            <InputRightElement width="3.5rem">
              <Button
                h="1.4rem"
                size="xs"
                onClick={handleCopyLink}
                _hover={{ bg: darkMode ? "#575759" : "gray.200" }}
                bgColor={darkMode ? "#575759" : "gray.200"}
                color={darkMode ? "white" : "inherit"}
              >
                Copy
              </Button>
            </InputRightElement>
          </InputGroup>

          <HStack mt={2} spacing={2} w="full">
            <Button
              size="sm"
              colorScheme={darkMode ? "whiteAlpha" : "blackAlpha"}
              borderColor={darkMode ? "blue.400" : "blue.600"}
              color={darkMode ? "blue.400" : "blue.600"}
              variant="outline"
              leftIcon={<VscCopy />}
              flex={1}
              isDisabled={!manifestReady || manifest.blocks.length === 0}
              onClick={handleCopyAll}
            >
              Copy
            </Button>
            <Button
              size="sm"
              colorScheme={darkMode ? "whiteAlpha" : "blackAlpha"}
              borderColor={darkMode ? "blue.400" : "blue.600"}
              color={darkMode ? "blue.400" : "blue.600"}
              variant="outline"
              leftIcon={<VscCloudDownload />}
              flex={1}
              isDisabled={!manifestReady || manifest.blocks.length === 0}
              onClick={handleExportAll}
            >
              Export
            </Button>
          </HStack>

          <Heading mt={4} mb={1.5} size="sm">
            Blocks
          </Heading>
          <Stack as="nav" aria-label="Blocks" spacing={1} fontSize="sm">
            <Button
              data-sidebar-add-block=""
              aria-label="Add block after current"
              leftIcon={<VscAdd />}
              size="sm"
              variant="outline"
              colorScheme={darkMode ? "whiteAlpha" : "blackAlpha"}
              w="full"
              isDisabled={!manifestReady}
              onClick={handleSidebarAddBlock}
            >
              Add Block
            </Button>
            {manifestUnusable ? (
              <Text color={darkMode ? "#888" : "#666"}>
                The block list could not be read.
              </Text>
            ) : manifestReady ? (
              manifest.blocks.map((block) => {
                const isCurrent = block.id === currentBlockId;
                return (
                  <SidebarBlockRow
                    key={block.id}
                    block={block}
                    isCurrent={isCurrent}
                    darkMode={darkMode}
                    autoFocusName={block.id === namingBlockId}
                    onSelect={() => selectBlockFromSidebar(block.id)}
                    onUpdateBlock={(patch) => updateBlock(block.id, patch)}
                    onNameBlur={() => {
                      setNamingBlockId((current) =>
                        current === block.id ? null : current,
                      );
                    }}
                    onRemove={() => requestDeleteBlock(block)}
                  />
                );
              })
            ) : (
              <Text color={darkMode ? "#888" : "#666"}>Loading...</Text>
            )}
          </Stack>

          <Heading mt={4} mb={1.5} size="sm">
            About
          </Heading>
          <Text fontSize="sm" mb={1.5}>
            <strong>Rustpad</strong> block mode — each block is an independent
            collaborative document. Add, reorder, or remove blocks as needed.
          </Text>
        </Container>
      )}

      {!sidebarCollapsed && (
        <Box
          display={{ base: "block", sm: "none" }}
          position="absolute"
          inset={0}
          zIndex={10}
          bgColor="blackAlpha.500"
          onClick={toggleSidebar}
        />
      )}

      <Flex flex={1} minW={0} h="100%" direction="column" overflow="hidden">
        <HStack
          h={6}
          spacing={1}
          color="#888888"
          fontWeight="medium"
          fontSize="13px"
          px={3.5}
          flexShrink={0}
        >
          <IconButton
            aria-label="Toggle sidebar"
            icon={
              <Icon
                as={
                  sidebarCollapsed
                    ? VscLayoutSidebarLeftOff
                    : VscLayoutSidebarLeft
                }
              />
            }
            size="xs"
            variant="ghost"
            color="#888888"
            _hover={{ color: darkMode ? "white" : "black" }}
            onClick={toggleSidebar}
            mr={1}
          />
          <Text>page: {id}</Text>
          <Text color="#aaa">
            ({manifestReady ? manifest.blocks.length : 0} block
            {manifestReady && manifest.blocks.length === 1 ? "" : "s"})
          </Text>
          <Select
            aria-label="Block presentation"
            size="xs"
            w="auto"
            value={presentation}
            onChange={(event) => {
              const next = event.target.value as BlockPresentation;
              setPresentation(next);
              saveBlockPresentation(id, next);
            }}
          >
            <option value="single">Single block</option>
            <option value="stacked">Stacked blocks</option>
          </Select>
        </HStack>

        <Box
          ref={scrollAreaRef}
          flex={1}
          minH={0}
          overflowY="auto"
          px={4}
          py={2}
          data-block-scroll=""
          data-presentation={presentation}
        >
          <VStack spacing={3} align="stretch">
            <Button
              leftIcon={<VscAdd />}
              size="sm"
              variant="outline"
              colorScheme={darkMode ? "whiteAlpha" : "gray"}
              isDisabled={!manifestReady}
              onClick={() => {
                addBlock();
              }}
            >
              Add Block
            </Button>

            {manifestUnusable ? (
              <Text
                data-manifest-unusable=""
                color={darkMode ? "#888" : "#666"}
              >
                The block list could not be read.
              </Text>
            ) : manifestReady && visibleManifest.blocks.length === 0 ? (
              <Text data-empty-page="" color={darkMode ? "#888" : "#666"}>
                This page has no blocks.
              </Text>
            ) : manifestReady ? (
              <Reorder.Group
                as="div"
                axis="y"
                values={orderIds}
                onReorder={handleReorder}
                style={{
                  position: "relative",
                  minHeight: single ? singleBodyHeight + 34 : undefined,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                  alignItems: "stretch",
                }}
              >
                {orderIds.map((blockId) => {
                  const block =
                    visibleManifest.blocks.find(
                      (entry) => entry.id === blockId,
                    ) ?? snapshotBlocksRef.current.get(blockId);
                  if (!block) return null;
                  return (
                    <ReorderableBlock
                      key={block.id}
                      pageId={id}
                      block={block}
                      single={single}
                      active={!single || block.id === currentBlockId}
                      singleBodyHeight={singleBodyHeight}
                      onClientChange={registerClient}
                      darkMode={darkMode}
                      wordWrap={wordWrap}
                      initialContent={initialContentByBlock.current[block.id]}
                      onUpdateBlock={(patch) => {
                        updateBlock(block.id, patch);
                      }}
                      onUpdateLayout={(layout) => {
                        updateBlockLayout(block.id, layout);
                      }}
                      onRemoveBlock={() => requestDeleteBlock(block)}
                      onMoveBlock={(dir) => {
                        moveBlock(block.id, dir);
                      }}
                      onContentChange={(content) =>
                        rememberBlockContent(block.id, content)
                      }
                      onEdited={() => {
                        if (currentBlockIdRef.current === block.id) return;
                        commitCurrentBlock(block.id);
                      }}
                      onCopyBlock={() => handleCopyBlock(block.id, block.title)}
                      onExportBlock={() =>
                        handleExportBlock(block.id, block.title, block.language)
                      }
                      onReorderEnd={handleReorderEnd}
                    />
                  );
                })}
              </Reorder.Group>
            ) : (
              <Text color={darkMode ? "#888" : "#666"}>
                Loading workspace...
              </Text>
            )}

            {manifest.blocks.length > 0 && (
              <Button
                leftIcon={<VscAdd />}
                size="sm"
                variant="outline"
                colorScheme={darkMode ? "whiteAlpha" : "gray"}
                isDisabled={!manifestReady}
                onClick={() => {
                  addBlock(undefined, "end");
                }}
              >
                Add Block
              </Button>
            )}
          </VStack>
        </Box>
      </Flex>

      <DeleteBlockConfirm
        isOpen={pendingDelete !== null}
        blockTitle={pendingDelete?.title ?? ""}
        onClose={cancelDeleteBlock}
        onConfirm={confirmDeleteBlock}
      />
    </Flex>
  );
}

export default BlockPageView;
