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
  VscLayoutSidebarLeft,
  VscLayoutSidebarLeftOff,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import BlockEditor from "./BlockEditor";
import {
  clearSingleToBlockTransfer,
  formatBlockSnapshot,
  loadBlockSnapshot,
  saveBlockToSingleTransfer,
  saveBlockSnapshot,
  takeSingleToBlockTransfer,
} from "./blockModeSync";
import { Manifest, useManifest } from "./BlockManifest";
import ConnectionStatus from "./ConnectionStatus";
import languageExtensions from "./extensions";
import Footer from "./Footer";
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
  const initialBlockTransfer = useRef(takeSingleToBlockTransfer(id));
  const initialSnapshot = useRef(
    initialBlockTransfer.current?.snapshot ?? loadBlockSnapshot(id),
  );
  const initialManifest = useRef<Manifest | undefined>(
    initialSnapshot.current
      ? {
          version: initialSnapshot.current.version,
          blocks: initialSnapshot.current.blocks.map(({ content, ...block }) => block),
        }
      : undefined,
  );
  const initialContentByBlock = useRef<Record<string, string>>(
    initialSnapshot.current
      ? Object.fromEntries(
          initialSnapshot.current.blocks.map((block) => [block.id, block.content]),
        )
      : {},
  );
  const { manifest, connection, addBlock, removeBlock, updateBlock, moveBlock } =
    useManifest(id, {
      initialManifest: initialManifest.current,
    });
  const liveBlockContents = useRef<Record<string, string>>({
    ...initialContentByBlock.current,
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState(
    "sidebarCollapsed",
    { defaultValue: false },
  );
  const [wordWrap, setWordWrap] = useLocalStorageState("wordWrap", {
    defaultValue: false,
  });

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  const rememberBlockContent = useCallback((blockId: string, content: string) => {
    liveBlockContents.current[blockId] = content;
    const nextContents = { ...liveBlockContents.current, [blockId]: content };
    saveBlockSnapshot(id, {
      version: manifest.version,
      blocks: manifest.blocks.map((block) => ({
        ...block,
        content:
          nextContents[block.id] ?? initialContentByBlock.current[block.id] ?? "",
      })),
    });
  }, [id, manifest]);

  useEffect(() => {
    if (!initialBlockTransfer.current) return;
    const clearId = window.setTimeout(() => clearSingleToBlockTransfer(id), 0);
    return () => window.clearTimeout(clearId);
  }, [id]);

  useEffect(() => {
    saveCurrentSnapshot();
  }, [id, manifest]);

  function saveCurrentSnapshot(nextContents = liveBlockContents.current) {
    const snapshot = {
      version: manifest.version,
      blocks: manifest.blocks.map((block) => ({
        ...block,
        content: nextContents[block.id] ?? initialContentByBlock.current[block.id] ?? "",
      })),
    };
    saveBlockSnapshot(id, snapshot);
    return snapshot;
  }

  function handleBlockModeChange() {
    const snapshot = saveCurrentSnapshot();
    saveBlockToSingleTransfer(id, {
      content: formatBlockSnapshot(snapshot),
      language:
        initialBlockTransfer.current?.documentLanguage ??
        snapshot.blocks[0]?.language ??
        "plaintext",
    });
    window.location.hash = id;
  }

  const documentUrl = `${window.location.origin}/#page:${id}`;

  async function handleCopy() {
    await navigator.clipboard.writeText(documentUrl);
    toast({
      title: "Copied!",
      description: "Link copied to clipboard",
      status: "success",
      duration: 2000,
      isClosable: true,
    });
  }

  async function handleExport() {
    if (manifest.blocks.length === 0) return;

    try {
      const entries = await Promise.all(
        manifest.blocks.map(
          (block) =>
            new Promise<[string, string]>((resolve, reject) => {
              const liveContent = liveBlockContents.current[block.id];
              if (liveContent !== undefined) {
                resolve([block.id, liveContent]);
                return;
              }

              let finished = false;
              const docId = `page:${id}:block:${block.id}`;
              const headless = new RustpadHeadless({
                uri: getWsUri(docId),
                onContentReady: (content) => finish(content),
                onDesynchronized: () => rejectOnce(),
              });
              const timeoutId = window.setTimeout(() => rejectOnce(), exportTimeoutMs);

              function finish(content: string) {
                if (finished) return;
                finished = true;
                window.clearTimeout(timeoutId);
                headless.dispose();
                resolve([block.id, content]);
              }

              function rejectOnce() {
                if (finished) return;
                finished = true;
                window.clearTimeout(timeoutId);
                headless.dispose();
                reject(new Error(`Failed to read block: ${block.title}`));
              }
            }),
        ),
      );
      const contents = Object.fromEntries(entries);
      const parts: string[] = [];
      for (const block of manifest.blocks) {
        parts.push(`// === ${block.title} (${block.language}) ===`);
        parts.push(contents[block.id] ?? "");
        parts.push("");
      }
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
        description: error instanceof Error ? error.message : "Could not read block contents.",
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

          <Flex justifyContent="space-between" mt={4} mb={1.5} w="full">
            <Heading size="sm">Block Mode</Heading>
            <Switch isChecked onChange={handleBlockModeChange} />
          </Flex>

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
                onClick={handleCopy}
                _hover={{ bg: darkMode ? "#575759" : "gray.200" }}
                bgColor={darkMode ? "#575759" : "gray.200"}
                color={darkMode ? "white" : "inherit"}
              >
                Copy
              </Button>
            </InputRightElement>
          </InputGroup>

          <Button
            size="sm"
            colorScheme={darkMode ? "whiteAlpha" : "blackAlpha"}
            borderColor={darkMode ? "blue.400" : "blue.600"}
            color={darkMode ? "blue.400" : "blue.600"}
            variant="outline"
            leftIcon={<VscCloudDownload />}
            mt={2}
            w="full"
            onClick={handleExport}
          >
            Export all blocks
          </Button>

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
              />
            ))}

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
          </VStack>
        </Box>
      </Flex>
    </Flex>
  );
}

export default BlockPageView;
