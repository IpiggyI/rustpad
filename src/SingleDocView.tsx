import { Box, Flex, HStack, Icon, IconButton, Text, useToast } from "@chakra-ui/react";
import Editor from "@monaco-editor/react";
import { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  VscChevronRight,
  VscFolderOpened,
  VscGist,
  VscLayoutSidebarLeft,
  VscLayoutSidebarLeftOff,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import rustpadRaw from "../rustpad-server/src/rustpad.rs?raw";
import languageExtensions from "./extensions";
import ReadCodeConfirm from "./ReadCodeConfirm";
import Sidebar from "./Sidebar";
import animals from "./animals.json";
import languages from "./languages.json";
import Rustpad, { UserInfo } from "./rustpad";
import { getWsUri } from "./useHash";

function generateName() {
  return "Anonymous " + animals[Math.floor(Math.random() * animals.length)];
}

function generateHue() {
  return Math.floor(Math.random() * 360);
}

function SingleDocView({ id, darkMode, onDarkModeChange }: {
  id: string;
  darkMode: boolean;
  onDarkModeChange: () => void;
}) {
  const toast = useToast();
  const [language, setLanguage] = useState("plaintext");
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const [users, setUsers] = useState<Record<number, UserInfo>>({});
  const [name, setName] = useLocalStorageState("name", {
    defaultValue: generateName,
  });
  const [hue, setHue] = useLocalStorageState("hue", {
    defaultValue: generateHue,
  });
  const [editor, setEditor] = useState<editor.IStandaloneCodeEditor>();
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState(
    "sidebarCollapsed",
    { defaultValue: false },
  );
  const [wordWrap, setWordWrap] = useLocalStorageState("wordWrap", {
    defaultValue: false,
  });
  const rustpad = useRef<Rustpad>();

  const [readCodeConfirmOpen, setReadCodeConfirmOpen] = useState(false);

  useEffect(() => {
    if (editor?.getModel()) {
      const model = editor.getModel()!;
      model.setValue("");
      model.setEOL(0); // LF
      rustpad.current = new Rustpad({
        uri: getWsUri(id),
        editor,
        onConnected: () => {
          setConnection("connected");
        },
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => {
          setConnection("desynchronized");
          toast({
            title: "Desynchronized with server",
            description: "Please save your work and refresh the page.",
            status: "error",
            duration: null,
          });
        },
        onChangeLanguage: (language) => {
          if (languages.includes(language)) {
            setLanguage(language);
          }
        },
        onChangeUsers: setUsers,
      });
      return () => {
        rustpad.current?.dispose();
        rustpad.current = undefined;
      };
    }
  }, [id, editor, toast, setUsers]);

  useEffect(() => {
    if (connection === "connected") {
      rustpad.current?.setInfo({ name, hue });
    }
  }, [connection, name, hue]);

  useEffect(() => {
    editor?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [editor, wordWrap]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  function handleExport() {
    const content = editor?.getModel()?.getValue();
    if (content == null) return;
    const ext = languageExtensions[language] ?? ".txt";
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopyContent() {
    const content = editor?.getModel()?.getValue();
    if (content == null) return;
    try {
      await navigator.clipboard.writeText(content);
      toast({
        title: "Copied!",
        description: "Content copied to clipboard",
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

  function handleBlockModeChange() {
    window.location.hash = `page:${id}`;
  }

  function handleLanguageChange(language: string) {
    setLanguage(language);
    if (rustpad.current?.setLanguage(language)) {
      toast({
        title: "Language updated",
        description: (
          <>
            All users are now editing in{" "}
            <Text as="span" fontWeight="semibold">
              {language}
            </Text>
            .
          </>
        ),
        status: "info",
        duration: 2000,
        isClosable: true,
      });
    }
  }

  function handleLoadSample(confirmed: boolean) {
    if (editor?.getModel()) {
      const model = editor.getModel()!;
      const range = model.getFullModelRange();

      if (range.endLineNumber >= 10 && !confirmed) {
        setReadCodeConfirmOpen(true);
        return;
      }

      model.pushEditOperations(
        editor.getSelections(),
        [{ range, text: rustpadRaw }],
        () => null,
      );
      editor.setPosition({ column: 0, lineNumber: 0 });
      if (language !== "rust") {
        handleLanguageChange("rust");
      }
    }
  }

  return (
    <Flex flex="1 0" minH={0}>
      {!sidebarCollapsed && (
        <Sidebar
          documentId={id}
          connection={connection}
          darkMode={darkMode}
          language={language}
          wordWrap={wordWrap}
          currentUser={{ name, hue }}
          users={users}
          onDarkModeChange={onDarkModeChange}
          onWordWrapChange={() => setWordWrap((prev) => !prev)}
          onBlockModeChange={handleBlockModeChange}
          onLanguageChange={handleLanguageChange}
          onLoadSample={() => handleLoadSample(false)}
          onExport={handleExport}
          onCopyContent={handleCopyContent}
          onChangeName={(name) => name.length > 0 && setName(name)}
          onChangeColor={() => setHue(generateHue())}
        />
      )}
      <ReadCodeConfirm
        isOpen={readCodeConfirmOpen}
        onClose={() => setReadCodeConfirmOpen(false)}
        onConfirm={() => {
          handleLoadSample(true);
          setReadCodeConfirmOpen(false);
        }}
      />

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
          <Icon as={VscFolderOpened} fontSize="md" color="blue.500" />
          <Text>documents</Text>
          <Icon as={VscChevronRight} fontSize="md" />
          <Icon as={VscGist} fontSize="md" color="purple.500" />
          <Text>{id}</Text>
        </HStack>
        <Box flex={1} minH={0}>
          <Editor
            theme={darkMode ? "vs-dark" : "vs"}
            language={language}
            options={{
              automaticLayout: true,
              fontSize: 13,
            }}
            onMount={(editor) => setEditor(editor)}
          />
        </Box>
      </Flex>
    </Flex>
  );
}

export default SingleDocView;
