import {
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
  chooseReplacementBlockId,
  loadCurrentBlockId,
  resolveCurrentBlockId,
  saveCurrentBlockId,
} from "./currentBlock";
import languageExtensions from "./extensions";
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
      layout="position"
      initial={false}
      style={{ position: "relative", width: "100%", minWidth: 0 }}
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
    updateTitle,
    removeBlock,
    updateBlock,
    updateBlockLayout,
    migrateLegacyLayout: adoptLegacyLayout,
    moveBlock,
    moveBlockBefore,
    ready: manifestReady,
  } = useManifest(id, {
    initialManifest: initialManifest.current,
  });
  const liveBlockContents = useRef<Record<string, string>>({});
  const currentBlockIdRef = useRef<string | null>(null);
  const lastOrderRef = useRef<string[]>([]);
  const lastPageIdRef = useRef<string | null>(null);
  const [currentBlockId, setCurrentBlockId] = useState<string | null>(null);
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

  function resolveBlockContent(
    blockId: string,
    blockTitle: string,
  ): Promise<string> {
    const live = liveBlockContents.current[blockId];
    if (live !== undefined) return Promise.resolve(live);

    return new Promise<string>((resolve, reject) => {
      let finished = false;
      const docId = `page:${id}:block:${blockId}`;
      const headless = new RustpadHeadless({
        uri: getWsUri(docId),
        onContentReady: (content) => finish(content),
        onDesynchronized: () => fallback(),
      });
      const timeoutId = window.setTimeout(() => fallback(), exportTimeoutMs);

      function finish(content: string) {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeoutId);
        headless.dispose();
        resolve(content);
      }

      function fallback() {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeoutId);
        headless.dispose();
        const cached = initialContentByBlock.current[blockId];
        if (cached !== undefined) {
          resolve(cached);
        } else {
          reject(new Error(`Failed to read block: ${blockTitle}`));
        }
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
            {manifestReady ? (
              manifest.blocks.map((block) => {
                const isCurrent = block.id === currentBlockId;
                return (
                  <Button
                    key={block.id}
                    data-block-id={block.id}
                    aria-current={isCurrent ? "true" : undefined}
                    variant="ghost"
                    size="sm"
                    h="auto"
                    minH={0}
                    py={1}
                    px={2}
                    w="full"
                    justifyContent="flex-start"
                    fontWeight={isCurrent ? "semibold" : "normal"}
                    bgColor={
                      isCurrent
                        ? darkMode
                          ? "#37373d"
                          : "gray.200"
                        : "transparent"
                    }
                    _hover={{
                      bgColor: darkMode ? "#323232" : "gray.100",
                    }}
                    onClick={() => selectBlockFromSidebar(block.id)}
                  >
                    <Text as="span" noOfLines={1}>
                      {block.title}{" "}
                      <Text as="span" color={darkMode ? "#888" : "#999"}>
                        ({block.language})
                      </Text>
                    </Text>
                  </Button>
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
        </HStack>

        <Box flex={1} overflowY="auto" px={4} py={2} data-block-scroll="">
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

            {manifestReady ? (
              <Reorder.Group
                as="div"
                axis="y"
                values={orderIds}
                onReorder={handleReorder}
                style={{
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
                      darkMode={darkMode}
                      wordWrap={wordWrap}
                      initialContent={initialContentByBlock.current[block.id]}
                      onUpdateBlock={(patch) => {
                        updateBlock(block.id, patch);
                      }}
                      onUpdateLayout={(layout) => {
                        updateBlockLayout(block.id, layout);
                      }}
                      onRemoveBlock={() => {
                        clearLegacyLayout(id, block.id);
                        removeBlock(block.id);
                      }}
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
    </Flex>
  );
}

export default BlockPageView;
