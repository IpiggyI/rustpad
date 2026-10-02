import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import {
  MAX_IMAGE_SIZE,
  attachImagePaste,
  findImageLinks,
  imageUploadError,
  imagesForPaste,
} from "../src/imagePaste.ts";

const png = new File(["png"], "first.png", { type: "image/png" });
const jpeg = new File(["jpeg"], "second.jpg", { type: "image/jpeg" });

test("non-empty text wins over images, including whitespace", () => {
  assert.deepEqual(imagesForPaste("copied text", [png], false), []);
  assert.deepEqual(imagesForPaste(" ", [png], false), []);
  assert.deepEqual(imagesForPaste("\n", [png], false), []);
});

test("empty text selects image files in clipboard order", () => {
  const text = new File(["text"], "note.txt", { type: "text/plain" });
  assert.deepEqual(imagesForPaste("", [png, text, jpeg], false), [png, jpeg]);
  assert.deepEqual(imagesForPaste("", [text], false), []);
  assert.deepEqual(imagesForPaste("", [], false), []);
});

test("read-only editors never intercept images", () => {
  assert.deepEqual(imagesForPaste("", [png], true), []);
});

test("validates all four formats and the inclusive 10 MiB boundary", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"])
    assert.equal(imageUploadError([{ type, size: MAX_IMAGE_SIZE }]), undefined);
  assert.equal(
    imageUploadError([{ type: "image/png", size: MAX_IMAGE_SIZE + 1 }]),
    "Image exceeds the 10 MiB size limit.",
  );
  for (const type of ["image/bmp", "image/svg+xml", "text/plain", ""])
    assert.equal(
      imageUploadError([{ type, size: 10 }]),
      "Unsupported image format.",
    );
});

test("detects only server image paths inside image references", () => {
  const line =
    "prefix ![image](api/images/a1.png) suffix ![photo](api/images/b2.webp)";
  const links = findImageLinks(line);
  assert.deepEqual(
    links.map((link) => link.path),
    ["api/images/a1.png", "api/images/b2.webp"],
  );
  for (const link of links)
    assert.equal(
      line.slice(link.startColumn - 1, link.endColumn - 1),
      link.path,
    );
  for (const ext of ["png", "jpg", "gif", "webp"])
    assert.equal(
      findImageLinks(`![image](api/images/123abc.${ext})`).length,
      1,
    );
  for (const text of [
    "api/images/a1.png",
    "[image](api/images/a1.png)",
    "![image](https://example.com/api/images/a1.png)",
    "![image](api/images/../a1.png)",
    "![image](api/images/A1.png)",
    "![image](api/images/a1.svg)",
    "![image](api/images/a1.png?download=1)",
  ])
    assert.deepEqual(findImageLinks(text), []);
});

function harness() {
  type PasteListener = (event: unknown) => void;
  const documentListeners = new Set<PasteListener>();
  const innerListeners = new Set<PasteListener>();
  let dispose: () => void;
  let changeModel: () => void;
  let changeContent: (event: { isFlush: boolean }) => void;
  let marker: unknown;
  let range: unknown = {
    startLineNumber: 2,
    startColumn: 3,
    endLineNumber: 2,
    endColumn: 7,
  };
  let readOnly = false;
  const edits: unknown[] = [];
  const errors: string[] = [];
  const providers: unknown[] = [];
  const disposable = { dispose() {} };
  const model = {
    deltaDecorations(old: string[], next: { range: unknown }[]) {
      marker = next[0];
      if (next.length) range = next[0].range;
      return next.length ? ["marker"] : [];
    },
    getDecorationRange: () => range,
    isDisposed: () => false,
  };
  function listen(listeners: Set<PasteListener>) {
    return {
      addEventListener(
        name: string,
        listener: PasteListener,
        capture: boolean,
      ) {
        assert.equal(name, "paste");
        assert.equal(capture, true);
        listeners.add(listener);
      },
      removeEventListener(
        name: string,
        listener: PasteListener,
        capture: boolean,
      ) {
        assert.equal(name, "paste");
        assert.equal(capture, true);
        listeners.delete(listener);
      },
    };
  }
  const document = listen(documentListeners);
  const node = { ...listen(innerListeners), ownerDocument: document };
  const editor = {
    getDomNode: () => node,
    getModel: () => model,
    getSelection: () => range,
    getOption: () => readOnly,
    pushUndoStop() {},
    executeEdits(source: string, operations: unknown[]) {
      assert.equal(source, "imageUpload");
      edits.push(...operations);
      return true;
    },
    onDidChangeModel(callback: typeof changeModel) {
      changeModel = callback;
      return disposable;
    },
    onDidChangeModelContent(callback: typeof changeContent) {
      changeContent = callback;
      return disposable;
    },
    onDidDispose(callback: typeof dispose) {
      dispose = callback;
      return disposable;
    },
  };
  const namespace = {
    editor: {
      EditorOption: { readOnly: 1 },
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
    },
    languages: {
      registerLinkProvider(selector: string, provider: unknown) {
        assert.equal(selector, "*");
        providers.push(provider);
      },
    },
    Range: class {
      constructor(
        startLineNumber: number,
        startColumn: number,
        endLineNumber: number,
        endColumn: number,
      ) {
        Object.assign(this, {
          startLineNumber,
          startColumn,
          endLineNumber,
          endColumn,
        });
      }
    },
  };
  const attach = () =>
    attachImagePaste(editor as never, namespace as never, (error) =>
      errors.push(error),
    );
  return {
    attach,
    edits,
    errors,
    providers,
    marker: () => marker,
    moveRange: (next: unknown) => {
      range = next;
    },
    setReadOnly: () => {
      readOnly = true;
    },
    dispose: () => dispose(),
    flush: () => changeContent({ isFlush: true }),
    listenerCount: () => documentListeners.size + innerListeners.size,
    paste(text: string, files: File[], insideEditor = true) {
      let prevented = false;
      let stopped = false;
      const event = {
        composedPath: () => (insideEditor ? [node, document] : [document]),
        clipboardData: { getData: () => text, files },
        preventDefault() {
          prevented = true;
        },
        stopImmediatePropagation() {
          stopped = true;
        },
      };
      for (const listener of documentListeners) {
        listener(event);
        if (stopped) break;
      }
      // Monaco's container capture listener precedes the inner editor node.
      if (
        !stopped &&
        insideEditor &&
        !readOnly &&
        text === "" &&
        files.length
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (!stopped && insideEditor)
        for (const listener of innerListeners) listener(event);
      return prevented;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function mockWindow(t: TestContext, href: string) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: { location: { href } },
    configurable: true,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

test("focused image paste reaches upload before the container stops propagation", async (t) => {
  mockWindow(t, "http://localhost/#doc");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(JSON.stringify({ path: "api/images/focused.png" }));
  });
  const h = harness();
  h.attach();
  assert.equal(h.paste("", [png]), true);
  await settle();
  assert.equal(requests, 1);
  assert.equal(h.edits.length, 1);
});

test("ancestor listener ignores other editors and is removed on disposal", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("Unexpected request");
  });
  const h = harness();
  h.attach();
  assert.equal(h.listenerCount(), 1);
  assert.equal(h.paste("", [png], false), false);
  assert.equal(h.paste("text", [png]), false);
  h.setReadOnly();
  assert.equal(h.paste("", [png]), false);
  await settle();
  assert.equal(requests, 0);
  assert.equal(h.marker(), undefined);
  assert.deepEqual(h.errors, []);
  h.dispose();
  assert.equal(h.listenerCount(), 0);
});

test("paste handler leaves text and read-only pastes untouched; invalid batches send no request", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("Unexpected request");
  });
  const h = harness();
  const uploader = h.attach();
  assert.equal(h.paste("text", [png]), false);
  assert.equal(
    h.paste("", [new File(["bmp"], "bad.bmp", { type: "image/bmp" })]),
    true,
  );
  uploader.upload([
    png,
    new File(["svg"], "bad.svg", { type: "image/svg+xml" }),
  ]);
  uploader.upload([
    new File([new Uint8Array(MAX_IMAGE_SIZE + 1)], "large.png", {
      type: "image/png",
    }),
  ]);
  h.setReadOnly();
  assert.equal(h.paste("", [png]), false);
  await settle();
  assert.equal(requests, 0);
  assert.equal(h.marker(), undefined);
  assert.deepEqual(h.edits, []);
  assert.deepEqual(h.errors, [
    "Unsupported image format.",
    "Unsupported image format.",
    "Image exceeds the 10 MiB size limit.",
  ]);
});

test("uses the live tracked selection, keeps upload order, and cleans the marker", async (t) => {
  mockWindow(t, "http://localhost/sub/#doc");
  let release: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "http://localhost/sub/api/images");
    assert.equal(options?.method, "POST");
    bodies.push(options?.body);
    await held;
    return new Response(
      JSON.stringify({ path: `api/images/returned${bodies.length}.png` }),
    );
  });
  const h = harness();
  h.attach().upload([png, jpeg]);
  assert.ok(h.marker());
  assert.deepEqual(h.edits, []);
  const moved = {
    startLineNumber: 4,
    startColumn: 3,
    endLineNumber: 4,
    endColumn: 7,
  };
  h.moveRange(moved);
  release!();
  await settle();
  assert.deepEqual(bodies, [png, jpeg]);
  assert.deepEqual(h.edits, [
    {
      range: moved,
      text: "![image](api/images/returned1.png)\n![image](api/images/returned2.png)",
    },
  ]);
  assert.equal(h.marker(), undefined);
  assert.deepEqual(h.errors, []);
});

for (const [status, message] of [
  [503, "Image uploads are disabled."],
  [415, "Unsupported image format."],
  [413, "Image exceeds the 10 MiB size limit."],
  [500, "Failed to store image."],
] as const) {
  test(`HTTP ${status} removes the marker and reports the server message`, async (t) => {
    mockWindow(t, "http://localhost/#doc");
    t.mock.method(console, "error", () => {});
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(message, { status }),
    );
    const h = harness();
    h.attach().upload([png]);
    await settle();
    assert.deepEqual(h.errors, [message]);
    assert.deepEqual(h.edits, []);
    assert.equal(h.marker(), undefined);
  });
}

test("network errors remove the marker and give a retry message", async (t) => {
  mockWindow(t, "http://localhost/#doc");
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  const h = harness();
  h.attach().upload([png]);
  await settle();
  assert.deepEqual(h.errors, ["Network error. Please try again."]);
  assert.deepEqual(h.edits, []);
  assert.equal(h.marker(), undefined);
});

for (const cancel of ["dispose", "flush"] as const) {
  test(`${cancel} cancels pending uploads without inserting into another document`, async (t) => {
    mockWindow(t, "http://localhost/#doc");
    let signal: AbortSignal;
    let release: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      signal = options!.signal!;
      await held;
      return new Response(JSON.stringify({ path: "api/images/a1.png" }));
    });
    const h = harness();
    h.attach().upload([png]);
    h[cancel]();
    assert.equal(signal!.aborted, true);
    release!();
    await settle();
    assert.deepEqual(h.edits, []);
    assert.deepEqual(h.errors, []);
    assert.equal(h.marker(), undefined);
  });
}

test("registers a link provider once per namespace and resolves against the page URL", (t) => {
  mockWindow(t, "https://example.com/sub/#doc");
  const h = harness();
  h.attach();
  h.attach();
  assert.equal(h.providers.length, 1);
  const provider = h.providers[0] as {
    provideLinks(model: unknown): { links: { url: string }[] };
  };
  const result = provider.provideLinks({
    getLineCount: () => 1,
    getLineContent: () => "![image](api/images/a1.png)",
  });
  assert.equal(
    result.links[0].url,
    "https://example.com/sub/api/images/a1.png",
  );
});
