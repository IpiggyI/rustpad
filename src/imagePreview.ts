import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { sanitizeCollapsedImages } from "./imageNames";
import { findImageLinks } from "./imagePaste";

type ImageSize = { width: number; height: number };
type Preview = {
  path: string;
  link: HTMLAnchorElement;
  image: HTMLImageElement;
  zone: monaco.editor.IViewZone;
  id: string;
};

export function attachImagePreviews(
  ed: monaco.editor.IStandaloneCodeEditor,
  m: typeof monaco,
  options: {
    collapsedImages?: unknown;
    onCollapsedImagesChange: (names: string[]) => void;
  },
) {
  const document = ed.getDomNode()?.ownerDocument;
  if (!document) return;
  const previews = new Map<string, Preview>();
  const sizes = new Map<string, ImageSize>();
  const buttons = new Map<
    number,
    {
      node: HTMLButtonElement;
      widget: monaco.editor.IGlyphMarginWidget;
      paths: string[];
    }
  >();
  let collapsedImages = new Set(
    sanitizeCollapsedImages(options.collapsedImages),
  );
  const originalGlyphMargin = ed.getOption(m.editor.EditorOption.glyphMargin);
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
    preview.link.style.width = failed
      ? "max-content"
      : `${size ? size.width * scale : 0}px`;
    preview.image.style.width = `${size && !failed ? size.width * scale : 0}px`;
    preview.image.style.height = `${size && !failed ? height : 0}px`;
    preview.image.style.display = failed ? "none" : "block";
    preview.link.querySelector<HTMLElement>(
      "[data-image-preview-error]",
    )!.hidden = !failed;
    const collapsed = collapsedImages.has(
      preview.path.slice("api/images/".length),
    );
    preview.link.style.display = collapsed ? "none" : "inline-block";
    preview.zone.heightInPx = collapsed ? 0 : height;
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
    link.style.display = "inline-block";
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
    const lines = new Map<number, string[]>();
    ed.changeViewZones((accessor) => {
      if (model) {
        for (let line = 1; line <= model.getLineCount(); line++) {
          for (const { path } of findImageLinks(model.getLineContent(line))) {
            lines.set(line, [...(lines.get(line) ?? []), path]);
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
            resize(preview);
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
    syncButtons(lines);
  }

  function syncButtons(lines: Map<number, string[]>) {
    const glyphMargin = lines.size > 0 || originalGlyphMargin;
    if (ed.getOption(m.editor.EditorOption.glyphMargin) !== glyphMargin)
      ed.updateOptions({ glyphMargin });
    buttons.forEach((button, line) => {
      if (lines.has(line)) return;
      ed.removeGlyphMarginWidget(button.widget);
      buttons.delete(line);
    });
    lines.forEach((paths, line) => {
      let button = buttons.get(line);
      if (!button) {
        button = createButton(line, paths);
        buttons.set(line, button);
        ed.addGlyphMarginWidget(button.widget);
      }
      button.paths = paths;
      const expanded = paths.some(
        (path) => !collapsedImages.has(path.slice("api/images/".length)),
      );
      button.node.title = expanded
        ? "Collapse image preview"
        : "Expand image preview";
      button.node.setAttribute("aria-label", button.node.title);
      button.node.setAttribute("aria-expanded", String(expanded));
      button.node.textContent = expanded ? "▾" : "▸";
      ed.layoutGlyphMarginWidget(button.widget);
    });
  }

  function createButton(line: number, paths: string[]) {
    const node = document!.createElement("button");
    node.type = "button";
    node.dataset.imagePreviewToggle = String(line);
    node.style.cssText =
      "border:0;background:transparent;color:inherit;cursor:pointer;padding:0;font-size:16px;line-height:1";
    const widget: monaco.editor.IGlyphMarginWidget = {
      getId: () => `${ed.getId()}:image-preview:${line}`,
      getDomNode: () => node,
      getPosition: () => ({
        lane: m.editor.GlyphMarginLane.Center,
        zIndex: 1,
        range: new m.Range(line, 1, line, 1),
      }),
    };
    return { node, widget, paths };
  }

  function setCollapsedImages(names: unknown) {
    collapsedImages = new Set(sanitizeCollapsedImages(names));
    sync();
  }

  function isPreviewHit(preview: Preview, path: EventTarget[]) {
    const error = preview.link.querySelector<HTMLElement>(
      "[data-image-preview-error]",
    )!;
    return (
      path.includes(preview.image) || (!error.hidden && path.includes(error))
    );
  }

  function click(event: MouseEvent) {
    if (event.button !== 0) return;
    const path = event.composedPath();
    for (const button of Array.from(buttons.values())) {
      if (!path.includes(button.node)) continue;
      event.preventDefault();
      event.stopImmediatePropagation();
      const names = button.paths.map((path) =>
        path.slice("api/images/".length),
      );
      const collapse = names.some((name) => !collapsedImages.has(name));
      names.forEach((name) =>
        collapse ? collapsedImages.add(name) : collapsedImages.delete(name),
      );
      sync();
      options.onCollapsedImagesChange(Array.from(collapsedImages).sort());
      return;
    }
    for (const preview of Array.from(previews.values())) {
      if (!isPreviewHit(preview, path)) continue;
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
        isPreviewHit(preview, path),
      ) &&
      !Array.from(buttons.values()).some((button) => path.includes(button.node))
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
      buttons.forEach((button) => ed.removeGlyphMarginWidget(button.widget));
      buttons.clear();
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
    buttons.clear();
    disposedEditor.dispose();
  });
  sync();
  return { setCollapsedImages };
}
