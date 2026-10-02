import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { findImageLinks } from "./imagePaste";

type ImageSize = { width: number; height: number };
type Preview = {
  path: string;
  link: HTMLAnchorElement;
  image: HTMLImageElement;
  zone: monaco.editor.IViewZone;
  id: string;
};

export function attachImagePreviews(ed: monaco.editor.IStandaloneCodeEditor) {
  const document = ed.getDomNode()?.ownerDocument;
  if (!document) return;
  const previews = new Map<string, Preview>();
  const sizes = new Map<string, ImageSize>();
  let disposed = false;

  function resize(preview: Preview) {
    const layout = ed.getLayoutInfo();
    const width = Math.max(
      0,
      layout.contentWidth - layout.verticalScrollbarWidth,
    );
    const size = sizes.get(preview.path);
    const failed = size?.height === 0;
    const scale =
      size && !failed ? Math.min(1, width / size.width, 320 / size.height) : 1;
    const height = size && !failed ? size.height * scale : 20;
    preview.link.style.width = `${width}px`;
    preview.image.style.width = `${size && !failed ? size.width * scale : 0}px`;
    preview.image.style.height = `${size && !failed ? height : 0}px`;
    preview.image.style.display = failed ? "none" : "block";
    preview.link.querySelector<HTMLElement>(
      "[data-image-preview-error]",
    )!.hidden = !failed;
    preview.zone.heightInPx = height;
  }

  function refreshSize(path: string) {
    if (disposed) return;
    ed.changeViewZones((accessor) => {
      previews.forEach((preview) => {
        if (preview.path !== path) return;
        resize(preview);
        accessor.layoutZone(preview.id);
      });
    });
  }

  function createPreview(path: string): Preview {
    const node = document!.createElement("div");
    node.dataset.imagePreview = path;
    node.style.overflow = "hidden";
    node.style.zIndex = "1";
    const link = document!.createElement("a");
    link.href = new URL(path, window.location.href).href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.style.display = "block";
    link.style.maxWidth = "100%";
    link.style.cursor = "pointer";
    const image = document!.createElement("img");
    image.alt = "Image preview";
    image.draggable = false;
    image.style.display = "block";
    const error = document!.createElement("span");
    error.dataset.imagePreviewError = "";
    error.textContent = "Failed to load image.";
    error.style.whiteSpace = "nowrap";
    error.hidden = true;
    link.append(image, error);
    node.append(link);
    const preview: Preview = {
      path,
      link,
      image,
      id: "",
      zone: {
        afterLineNumber: 0,
        heightInPx: 20,
        domNode: node,
        suppressMouseDown: true,
      },
    };
    resize(preview);
    image.onload = () => {
      sizes.set(path, {
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      refreshSize(path);
    };
    image.onerror = () => {
      console.error("Failed to load image preview", link.href);
      sizes.set(path, { width: 0, height: 0 });
      refreshSize(path);
    };
    if (sizes.get(path)?.height !== 0) image.src = link.href;
    return preview;
  }

  function removePreview(
    preview: Preview,
    accessor: monaco.editor.IViewZoneChangeAccessor,
  ) {
    preview.image.onload = null;
    preview.image.onerror = null;
    accessor.removeZone(preview.id);
  }

  function sync() {
    const model = ed.getModel();
    const used = new Set<string>();
    const occurrences = new Map<string, number>();
    ed.changeViewZones((accessor) => {
      if (model) {
        for (let line = 1; line <= model.getLineCount(); line++) {
          for (const { path } of findImageLinks(model.getLineContent(line))) {
            const occurrence = occurrences.get(path) ?? 0;
            occurrences.set(path, occurrence + 1);
            const key = `${path}:${occurrence}`;
            used.add(key);
            let preview = previews.get(key);
            if (!preview) {
              preview = createPreview(path);
              previews.set(key, preview);
            }
            preview.zone.afterLineNumber = line;
            // Keep visibility tied to this line, including a visible folded heading.
            preview.zone.afterColumn = model.getLineMaxColumn(line) - 1;
            preview.zone.ordinal = used.size;
            if (preview.id) accessor.layoutZone(preview.id);
            else preview.id = accessor.addZone(preview.zone);
          }
        }
      }
      previews.forEach((preview, key) => {
        if (used.has(key)) return;
        removePreview(preview, accessor);
        previews.delete(key);
      });
    });
  }

  function click(event: MouseEvent) {
    if (event.button !== 0) return;
    const path = event.composedPath();
    for (const preview of Array.from(previews.values())) {
      if (!path.includes(preview.link)) continue;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.open(preview.link.href, "_blank", "noopener,noreferrer");
      return;
    }
  }

  function suppressEditorMouse(event: Event) {
    const path = event.composedPath();
    if (
      !Array.from(previews.values()).some((preview) =>
        path.includes(preview.link),
      )
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // Capture before Monaco's mouse handling; taps also produce a click.
  document.addEventListener("click", click, true);
  document.addEventListener("pointerdown", suppressEditorMouse, true);
  document.addEventListener("mousedown", suppressEditorMouse, true);
  const listeners = [
    ed.onDidChangeModelContent(sync),
    ed.onDidChangeModel(() => {
      previews.forEach((preview) => {
        preview.image.onload = null;
        preview.image.onerror = null;
      });
      previews.clear();
      sizes.clear();
      sync();
    }),
    ed.onDidLayoutChange(() => {
      ed.changeViewZones((accessor) => {
        previews.forEach((preview) => {
          resize(preview);
          accessor.layoutZone(preview.id);
        });
      });
    }),
  ];
  const disposedEditor = ed.onDidDispose(() => {
    disposed = true;
    document.removeEventListener("click", click, true);
    document.removeEventListener("pointerdown", suppressEditorMouse, true);
    document.removeEventListener("mousedown", suppressEditorMouse, true);
    listeners.forEach((listener) => listener.dispose());
    previews.forEach((preview) => {
      preview.image.onload = null;
      preview.image.onerror = null;
    });
    previews.clear();
    sizes.clear();
    disposedEditor.dispose();
  });
  sync();
}
