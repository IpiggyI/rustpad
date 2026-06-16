import {
  Button,
  Container,
  Flex,
  HStack,
  Heading,
  Input,
  InputGroup,
  InputRightElement,
  Link,
  Select,
  Stack,
  Switch,
  Text,
  useToast,
} from "@chakra-ui/react";
import { VscCloudDownload, VscCopy, VscRepo } from "react-icons/vsc";

import ConnectionStatus from "./ConnectionStatus";
import User from "./User";
import languages from "./languages.json";
import type { UserInfo } from "./rustpad";

export type SidebarProps = {
  documentId: string;
  connection: "connected" | "disconnected" | "desynchronized";
  darkMode: boolean;
  language: string;
  wordWrap: boolean;
  documentTitle: string;
  currentUser: UserInfo;
  users: Record<number, UserInfo>;
  onDarkModeChange: () => void;
  onWordWrapChange: () => void;
  onBlockModeChange: () => void;
  onLanguageChange: (language: string) => void;
  onLoadSample: () => void;
  onExport: () => void;
  onCopyContent: () => void;
  onChangeName: (name: string) => void;
  onChangeColor: () => void;
  onChangeDocumentTitle: (title: string) => void;
};

function Sidebar({
  documentId,
  connection,
  darkMode,
  language,
  wordWrap,
  documentTitle,
  currentUser,
  users,
  onDarkModeChange,
  onWordWrapChange,
  onBlockModeChange,
  onLanguageChange,
  onLoadSample,
  onExport,
  onCopyContent,
  onChangeName,
  onChangeColor,
  onChangeDocumentTitle,
}: SidebarProps) {
  const toast = useToast();

  // For sharing the document by link to others.
  const documentUrl = `${window.location.origin}/#${documentId}`;

  async function handleCopy() {
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

  return (
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
        <Switch isChecked={wordWrap} onChange={onWordWrapChange} />
      </Flex>

      <Button
        size="sm"
        colorScheme={darkMode ? "whiteAlpha" : "blackAlpha"}
        variant="outline"
        mt={4}
        w="full"
        onClick={onBlockModeChange}
      >
        Open Block Workspace
      </Button>

      <Heading mt={4} mb={1.5} size="sm">
        Document Title
      </Heading>
      <Input
        size="sm"
        placeholder={documentId}
        bgColor={darkMode ? "#3c3c3c" : "white"}
        borderColor={darkMode ? "#3c3c3c" : "white"}
        value={documentTitle}
        onChange={(e) => onChangeDocumentTitle(e.target.value)}
      />

      <Heading mt={4} mb={1.5} size="sm">
        Language
      </Heading>
      <Select
        size="sm"
        bgColor={darkMode ? "#3c3c3c" : "white"}
        borderColor={darkMode ? "#3c3c3c" : "white"}
        value={language}
        onChange={(event) => onLanguageChange(event.target.value)}
      >
        {languages.map((lang) => (
          <option key={lang} value={lang} style={{ color: "black" }}>
            {lang}
          </option>
        ))}
      </Select>

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

      <HStack mt={2} spacing={2} w="full">
        <Button
          size="sm"
          colorScheme={darkMode ? "whiteAlpha" : "blackAlpha"}
          borderColor={darkMode ? "blue.400" : "blue.600"}
          color={darkMode ? "blue.400" : "blue.600"}
          variant="outline"
          leftIcon={<VscCopy />}
          flex={1}
          onClick={onCopyContent}
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
          onClick={onExport}
        >
          Export
        </Button>
      </HStack>

      <Heading mt={4} mb={1.5} size="sm">
        Active Users
      </Heading>
      <Stack spacing={0} mb={1.5} fontSize="sm">
        <User
          info={currentUser}
          isMe
          onChangeName={onChangeName}
          onChangeColor={onChangeColor}
          darkMode={darkMode}
        />
        {Object.entries(users).map(([id, info]) => (
          <User key={id} info={info} darkMode={darkMode} />
        ))}
      </Stack>

      <Heading mt={4} mb={1.5} size="sm">
        About
      </Heading>
      <Text fontSize="sm" mb={1.5}>
        <strong>Rustpad</strong> is an open-source collaborative text editor
        based on the <em>operational transformation</em> algorithm.
      </Text>
      <Text fontSize="sm" mb={1.5}>
        Share a link to this pad with others, and they can edit from their
        browser while seeing your changes in real time.
      </Text>
      <Text fontSize="sm" mb={1.5}>
        Built using Rust and TypeScript. See the{" "}
        <Link
          color="blue.600"
          fontWeight="semibold"
          href="https://github.com/ekzhang/rustpad"
          isExternal
        >
          GitHub repository
        </Link>{" "}
        for details.
      </Text>

      <Button
        size="sm"
        colorScheme={darkMode ? "whiteAlpha" : "blackAlpha"}
        borderColor={darkMode ? "purple.400" : "purple.600"}
        color={darkMode ? "purple.400" : "purple.600"}
        variant="outline"
        leftIcon={<VscRepo />}
        mt={1}
        onClick={onLoadSample}
      >
        Read the code
      </Button>
    </Container>
  );
}

export default Sidebar;
