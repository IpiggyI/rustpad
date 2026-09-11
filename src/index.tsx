import { ChakraProvider } from "@chakra-ui/react";
import { loader } from "@monaco-editor/react";
import monacoPackage from "monaco-editor/package.json";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as wasm from "rustpad-wasm";

import App from "./App";
import "./index.css";
import { registerMarkdownFolding } from "./markdownFolding";

loader.config({
  paths: {
    vs: `https://cdn.jsdelivr.net/npm/monaco-editor@${monacoPackage.version}/min/vs`,
  },
});
loader.init().then(registerMarkdownFolding);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChakraProvider>
      <App />
    </ChakraProvider>
  </StrictMode>,
);
