import { Box, Flex } from "@chakra-ui/react";
import useLocalStorageState from "use-local-storage-state";

import BlockPageView from "./BlockPageView";
import Footer from "./Footer";
import SingleDocView from "./SingleDocView";
import { useHashInfo } from "./useHash";

function App() {
  const hashInfo = useHashInfo();
  const [darkMode, setDarkMode] = useLocalStorageState("darkMode", {
    defaultValue: false,
  });

  function handleDarkModeChange() {
    setDarkMode(!darkMode);
  }

  return (
    <Flex
      direction="column"
      h="100vh"
      overflow="hidden"
      bgColor={darkMode ? "#1e1e1e" : "white"}
      color={darkMode ? "#cbcaca" : "inherit"}
    >
      <Box
        flexShrink={0}
        bgColor={darkMode ? "#333333" : "#e8e8e8"}
        color={darkMode ? "#cccccc" : "#383838"}
        textAlign="center"
        fontSize="sm"
        py={0.5}
      >
        Rustpad
      </Box>
      {hashInfo.mode === "single" ? (
        <SingleDocView
          id={hashInfo.id}
          darkMode={darkMode}
          onDarkModeChange={handleDarkModeChange}
        />
      ) : (
        <BlockPageView
          id={hashInfo.id}
          darkMode={darkMode}
          onDarkModeChange={handleDarkModeChange}
        />
      )}
      <Footer />
    </Flex>
  );
}

export default App;
