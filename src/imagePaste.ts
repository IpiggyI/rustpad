import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { IMAGE_FILE_PATTERN, localImageDate } from "./imageNames";

type Monaco = typeof monaco;

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export function imagesForPaste(
  text: string,
  files: readonly File[],
  readOnly: boolean,
): File[] {
  if (readOnly || text !== "") return [];
  return files.filter((file) => file.type.startsWith("image/"));
}

export function imageUploadError(
  files: readonly Pick<File, "size" | "type">[],
): string | undefined {
  for (const file of files) {
    if (!IMAGE_ACCEPT.split(",").includes(file.type))
      return "Unsupported image format.";
    if (file.size > MAX_IMAGE_SIZE)
      return "Image exceeds the 10 MiB size limit.";
  }
}

export function findImageLinks(line: string) {
  const pattern = new RegExp(
    `!\\[[^\\]\\r\\n]*\\]\\((api/images/${IMAGE_FILE_PATTERN})\\)`,
    "g",
  );
  const links: { path: string; startColumn: number; endColumn: number }[] = [];
  let match;
  while ((match = pattern.exec(line))) {
    const startColumn = match.index + match[0].indexOf("](") + 3;
    links.push({
      path: match[1],
      startColumn,
      endColumn: startColumn + match[1].length,
    });
  }
  return links;
}

const registeredNamespaces = new WeakSet<Monaco>();

function registerImageLinks(m: Monaco) {
  if (registeredNamespaces.has(m)) return;
  m.languages.registerLinkProvider("*", {
    provideLinks(model) {
      const links: monaco.languages.ILink[] = [];
      for (
        let lineNumber = 1;
        lineNumber <= model.getLineCount();
        lineNumber++
      ) {
        for (const link of findImageLinks(model.getLineContent(lineNumber))) {
          links.push({
            range: new m.Range(
              lineNumber,
              link.startColumn,
              lineNumber,
              link.endColumn,
            ),
            url: new URL(link.path, window.location.href).href,
            tooltip: "Open original image",
          });
        }
      }
      return { links };
    },
  });
  registeredNamespaces.add(m);
}

async function uploadImage(file: File, signal: AbortSignal): Promise<string> {
  const url = new URL("api/images", window.location.href);
  url.searchParams.set("date", localImageDate());
  const response = await fetch(url, {
    method: "POST",
    body: file,
    signal,
  });
  if (!response.ok) throw new Error(await response.text());
  const result: { path: string } = await response.json();
  return `![image](${result.path})`;
}

export function attachImagePaste(
  ed: monaco.editor.IStandaloneCodeEditor,
  m: Monaco,
  onError: (message: string) => void,
) {
  registerImageLinks(m);
  const node = ed.getDomNode();
  const pasteTarget = node?.ownerDocument;
  const pending = new Set<AbortController>();
  let disposed = false;
  const readOnly = () => ed.getOption(m.editor.EditorOption.readOnly);

  async function insertImages(
    files: readonly File[],
    model: monaco.editor.ITextModel,
    marker: string,
    controller: AbortController,
  ) {
    try {
      const references = [];
      for (const file of files)
        references.push(await uploadImage(file, controller.signal));
      const range = model.getDecorationRange(marker);
      if (controller.signal.aborted || ed.getModel() !== model || !range)
        return;
      if (readOnly()) throw new Error("The editor is read-only.");
      ed.pushUndoStop();
      if (
        !ed.executeEdits("imageUpload", [
          { range, text: references.join("\n") },
        ])
      )
        throw new Error("Failed to insert image references.");
      ed.pushUndoStop();
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("Image upload failed", error);
        onError(
          error instanceof TypeError
            ? "Network error. Please try again."
            : error instanceof Error
              ? error.message
              : "Image upload failed.",
        );
      }
    } finally {
      if (!model.isDisposed()) model.deltaDecorations([marker], []);
      pending.delete(controller);
    }
  }

  function upload(files: readonly File[]) {
    const model = ed.getModel();
    const selection = ed.getSelection();
    if (disposed || readOnly() || !model || !selection || files.length === 0)
      return;
    const error = imageUploadError(files);
    if (error) {
      onError(error);
      return;
    }
    const [marker] = model.deltaDecorations(
      [],
      [
        {
          range: selection,
          options: {
            stickiness:
              m.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            showIfCollapsed: true,
            before: {
              content: "[Uploading...] ",
              inlineClassName: "image-upload-marker",
            },
          },
        },
      ],
    );
    const controller = new AbortController();
    pending.add(controller);
    void insertImages(files, model, marker, controller);
  }

  function paste(event: ClipboardEvent) {
    if (!node || !event.composedPath().includes(node)) return;
    const data = event.clipboardData;
    if (!data) return;
    const files = imagesForPaste(
      data.getData("text/plain"),
      Array.from(data.files),
      readOnly(),
    );
    if (files.length === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    upload(files);
  }

  // Monaco captures paste on its container; the document runs before that handler.
  pasteTarget?.addEventListener("paste", paste, true);
  const changedModel = ed.onDidChangeModel(() => {
    pending.forEach((controller) => controller.abort());
  });
  const changedContent = ed.onDidChangeModelContent((event) => {
    if (event.isFlush) pending.forEach((controller) => controller.abort());
  });
  const disposedEditor = ed.onDidDispose(() => {
    disposed = true;
    pasteTarget?.removeEventListener("paste", paste, true);
    pending.forEach((controller) => controller.abort());
    changedModel.dispose();
    changedContent.dispose();
    disposedEditor.dispose();
  });
  return { upload };
}
