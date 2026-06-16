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
import { useCallback, useEffect, useRef } from "react";
import {
  VscAdd,
  VscCloudDownload,
  VscCopy,
  VscLayoutSidebarLeft,
  VscLayoutSidebarLeftOff,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import BlockEditor from "./BlockEditor";
import { Manifest, useManifest } from "./BlockManifest";
import ConnectionStatus from "./ConnectionStatus";
import Footer from "./Footer";
import { loadBlockSnapshot, saveBlockSnapshot } from "./blockModeSync";
import languageExtensions from "./extensions";
import RustpadHeadless from "./rustpad-headless";
import { getWsUri } from "./useHash";

const exportTimeoutMs = 10000;

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
      ? {
          version: initialSnapshot.current.version,
          blocks: initialSnapshot.current.blocks.map(
            ({ content, ...block }) => block,
          ),
        }
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
    moveBlock,
  } = useManifest(id, {
    initialManifest: initialManifest.current,
  });
  const liveBlockContents = useRef<Record<string, string>>({});

  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState(
    "sidebarCollapsed",
    { defaultValue: false },
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
    setDocumentTitle(title);
    updateTitle(title);
  }

  const rememberBlockContent = useCallback(
    (blockId: string, content: string) => {
      liveBlockContents.current[blockId] = content;
      const nextContents = { ...liveBlockContents.current, [blockId]: content };
      saveBlockSnapshot(id, {
        version: manifest.version,
        blocks: manifest.blocks.map((block) => ({
          ...block,
          content:
            nextContents[block.id] ??
            initialContentByBlock.current[block.id] ??
            "",
        })),
      });
    },
    [id, manifest],
  );

  useEffect(() => {
    saveCurrentSnapshot();
  }, [id, manifest]);

  function saveCurrentSnapshot(nextContents = liveBlockContents.current) {
    const snapshot = {
      version: manifest.version,
      blocks: manifest.blocks.map((block) => ({
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
    saveCurrentSnapshot();
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
    if (manifest.blocks.length === 0) return;
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
    if (manifest.blocks.length === 0) return;
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
    <Flex flex="1 0" minH={0}>
      {!sidebarCollapsed && (
        <Container
          w={{ base: "3xs", md: "2xs", lg: "xs" }}
          display={{ base: "none", sm: "block" }}
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
          <Input
            size="sm"
            placeholder={id}
            bgColor={darkMode ? "#3c3c3c" : "white"}
            borderColor={darkMode ? "#3c3c3c" : "white"}
            value={documentTitle}
            onChange={(e) => handleDocumentTitleChange(e.target.value)}
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
              onClick={handleExportAll}
            >
              Export
            </Button>
          </HStack>

          <Heading mt={4} mb={1.5} size="sm">
            Blocks
          </Heading>
          <Stack spacing={1} fontSize="sm">
            {manifest.blocks.map((block) => (
              <Text key={block.id} noOfLines={1}>
                {block.title}{" "}
                <Text as="span" color={darkMode ? "#888" : "#999"}>
                  ({block.language})
                </Text>
              </Text>
            ))}
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
            ({manifest.blocks.length} block
            {manifest.blocks.length !== 1 ? "s" : ""})
          </Text>
        </HStack>

        <Box flex={1} overflowY="auto" px={4} py={2}>
          <VStack spacing={3} align="stretch">
            <Button
              leftIcon={<VscAdd />}
              size="sm"
              variant="outline"
              colorScheme={darkMode ? "whiteAlpha" : "gray"}
              onClick={() => {
                addBlock();
              }}
            >
              Add Block
            </Button>

            {manifest.blocks.map((block) => (
              <BlockEditor
                key={block.id}
                pageId={id}
                block={block}
                darkMode={darkMode}
                wordWrap={wordWrap}
                initialContent={initialContentByBlock.current[block.id]}
                onUpdateBlock={(patch) => {
                  updateBlock(block.id, patch);
                }}
                onRemoveBlock={() => {
                  removeBlock(block.id);
                }}
                onMoveBlock={(dir) => {
                  moveBlock(block.id, dir);
                }}
                onContentChange={(content) =>
                  rememberBlockContent(block.id, content)
                }
                onCopyBlock={() => handleCopyBlock(block.id, block.title)}
                onExportBlock={() =>
                  handleExportBlock(block.id, block.title, block.language)
                }
              />
            ))}
          </VStack>
        </Box>
      </Flex>
    </Flex>
  );
}

export default BlockPageView;
