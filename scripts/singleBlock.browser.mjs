/**
 * Real Chromium acceptance for the single-block presentation.
 *
 * Prerequisites match the other browser scripts: run the Vite frontend and the
 * backend on their usual ports, and install Playwright Chromium (or set
 * CHROMIUM_PATH).
 */
import assert from "node:assert/strict";

const base = process.env.RUSTPAD_URL || "http://127.0.0.1:5173";
const origin = new URL(base).origin;

try {
  const response = await fetch(base, { signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(
    `Cannot reach ${base}. Start npm run dev or set RUSTPAD_URL.`,
    error,
  );
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import(
    process.env.PLAYWRIGHT_MODULE || "playwright-core"
  ));
} catch (error) {
  console.error("Cannot load Playwright. Run npm ci first.", error);
  process.exit(1);
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
} catch (error) {
  console.error(
    "Chromium could not be launched. Install it or set CHROMIUM_PATH.",
    error,
  );
  process.exit(1);
}

const blocks = [
  {
    id: "aaaaaa",
    title: "Alpha",
    language: "markdown",
    height: 260,
  },
  {
    id: "bbbbbb",
    title: "Beta",
    language: "plaintext",
    height: 220,
  },
  {
    id: "cccccc",
    title: "Gamma",
    language: "plaintext",
    height: 333,
    collapsed: true,
  },
];

const alphaSeed = [
  "# Alpha",
  ...Array.from(
    { length: 44 },
    (_, index) =>
      `alpha line ${String(index + 1).padStart(2, "0")} ${"x".repeat(80)}`,
  ),
  "# Tail",
  "tail body",
].join("\n");
const betaSeed = "beta initial";
const gammaSeed = "gamma initial";

function wsUrl(docId) {
  const url = new URL(`api/socket/${docId}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function docId(pageId, blockId) {
  return `page:${pageId}:block:${blockId}`;
}

function presentationKey(pageId) {
  return `blockPresentation:page:${pageId}`;
}

async function seedText(id, text) {
  const ws = new WebSocket(wsUrl(id));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`seed timeout: ${id}`)),
      8000,
    );
    let sent = false;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.History === undefined) return;
      if (!sent) {
        assert.deepEqual(message.History.operations, []);
        sent = true;
        ws.send(JSON.stringify({ Edit: { revision: 0, operation: [text] } }));
        return;
      }
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  ws.close();
}

async function fetchText(id) {
  const response = await fetch(new URL(`api/text/${id}`, base));
  assert.equal(
    response.ok,
    true,
    `failed to read ${id}: HTTP ${response.status}`,
  );
  return response.text();
}

async function fetchManifest(pageId) {
  const text = await fetchText(`page:${pageId}:manifest`);
  return text.trim() ? JSON.parse(text) : null;
}

async function waitUntil(predicate, message, timeout = 10000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${message}; last=${JSON.stringify(last)}`);
}

async function waitForManifest(pageId, predicate, message) {
  return waitUntil(async () => {
    const manifest = await fetchManifest(pageId);
    return manifest && predicate(manifest) ? manifest : false;
  }, message);
}

async function openWorkspace(context, pageId, count = 3) {
  const page = await context.newPage();
  await page.goto(`${base}/#page:${pageId}`);
  await page.evaluate(() =>
    document.querySelector("vite-error-overlay")?.remove(),
  );
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page
    .getByText(`(${count} block${count === 1 ? "" : "s"})`, {
      exact: true,
    })
    .waitFor();
  await page.waitForFunction(
    (expected) => (window.monaco?.editor.getEditors().length ?? 0) === expected,
    count,
  );
  return page;
}

async function currentBlockId(page) {
  const current = page.locator(
    'nav[aria-label="Blocks"] [aria-current="true"]',
  );
  return (await current.count()) === 0
    ? null
    : current.getAttribute("data-block-id");
}

async function selectBlock(page, blockId) {
  await page
    .locator(`nav[aria-label="Blocks"] [data-block-id="${blockId}"]`)
    .click();
  await page.waitForFunction(
    (wanted) =>
      document
        .querySelector('nav[aria-label="Blocks"] [aria-current="true"]')
        ?.getAttribute("data-block-id") === wanted,
    blockId,
  );
}

async function selectPresentation(page, value) {
  await page.getByLabel("Block presentation").selectOption(value);
  await page.waitForFunction(
    (wanted) =>
      document
        .querySelector("[data-block-scroll]")
        ?.getAttribute("data-presentation") === wanted,
    value,
  );
}

async function clickUserAction(locator, description) {
  try {
    await locator.click({ timeout: 5000 });
  } catch (error) {
    const pointerStack = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return document
        .elementsFromPoint(x, y)
        .slice(0, 8)
        .map((hit) => ({
          tag: hit.tagName.toLowerCase(),
          ariaLabel: hit.getAttribute("aria-label"),
          blockPanel: hit.getAttribute("data-block-panel"),
          className: typeof hit.className === "string" ? hit.className : null,
        }));
    });
    assert.fail(
      `${description} was not pointer-clickable; pointerStack=${JSON.stringify(pointerStack)}; ${error}`,
    );
  }
}

async function waitForToastToClose(page, title) {
  const toast = page.getByText(title, { exact: true });
  if ((await toast.count()) > 0) {
    await toast.last().waitFor({ state: "hidden", timeout: 6000 });
  }
}

async function editorValue(page, pageId, blockId) {
  return page.evaluate(
    ({ pageId, blockId }) => {
      const uri = `rustpad-block://${pageId}/${blockId}`;
      return (
        window.monaco.editor
          .getEditors()
          .find((candidate) => candidate.getModel()?.uri.toString() === uri)
          ?.getValue() ?? null
      );
    },
    { pageId, blockId },
  );
}

async function waitForEditorValue(page, pageId, blockId, predicateText) {
  await page.waitForFunction(
    ({ pageId, blockId, predicateText }) => {
      const uri = `rustpad-block://${pageId}/${blockId}`;
      const value = window.monaco.editor
        .getEditors()
        .find((candidate) => candidate.getModel()?.uri.toString() === uri)
        ?.getValue();
      return value?.includes(predicateText) === true;
    },
    { pageId, blockId, predicateText },
  );
}

async function appendToEditor(page, pageId, blockId, text, source) {
  await page.evaluate(
    ({ pageId, blockId, text, source }) => {
      const uri = `rustpad-block://${pageId}/${blockId}`;
      const editor = window.monaco.editor
        .getEditors()
        .find((candidate) => candidate.getModel()?.uri.toString() === uri);
      if (!editor) throw new Error(`missing editor ${uri}`);
      const model = editor.getModel();
      const end = model.getFullModelRange().getEndPosition();
      editor.pushUndoStop();
      editor.executeEdits(source, [
        {
          range: new window.monaco.Range(
            end.lineNumber,
            end.column,
            end.lineNumber,
            end.column,
          ),
          text,
        },
      ]);
      editor.pushUndoStop();
    },
    { pageId, blockId, text, source },
  );
}

async function bodyState(page, blockId) {
  return page.evaluate((id) => {
    const body = document.querySelector(`[data-block-body="${id}"]`);
    const panel = document.querySelector(`[data-block-panel="${id}"]`);
    if (!body || !panel) return null;
    return {
      bodyVisibility: getComputedStyle(body).visibility,
      panelVisibility: getComputedStyle(panel).visibility,
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      bodyWidth: Math.round(body.getBoundingClientRect().width),
    };
  }, blockId);
}

function layoutFields(manifest) {
  return manifest.blocks.map(({ id, height, collapsed }) => ({
    id,
    height,
    collapsed: collapsed ?? false,
  }));
}

async function readClipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function streamText(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function installWebSocketProbe(context) {
  const records = [];
  let heldDoc = null;
  let heldMessages = [];
  let dropNextHistoryDoc = null;

  await context.routeWebSocket(/\/api\/socket\//, (route) => {
    const server = route.connectToServer();
    const decodedUrl = decodeURIComponent(route.url());
    const record = {
      url: decodedUrl,
      edits: 0,
      histories: 0,
      droppedHistory: false,
      close() {
        server.close();
        route.close();
      },
    };
    records.push(record);
    const dropHistory =
      dropNextHistoryDoc !== null && decodedUrl.includes(dropNextHistoryDoc);
    if (dropHistory) dropNextHistoryDoc = null;

    route.onMessage((message) => {
      const text = String(message);
      try {
        if (JSON.parse(text).Edit !== undefined) record.edits += 1;
      } catch {
        // Forward non-JSON protocol messages unchanged.
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const text = String(message);
      let history = null;
      try {
        history = JSON.parse(text).History ?? null;
      } catch {
        // Forward non-JSON protocol messages unchanged.
      }
      if (history) record.histories += 1;
      if (dropHistory && history) {
        record.droppedHistory = true;
        return;
      }
      if (
        heldDoc !== null &&
        decodedUrl.includes(heldDoc) &&
        history?.operations?.length > 0
      ) {
        heldMessages.push({ route, message });
        return;
      }
      route.send(message);
    });
  });

  const matching = (id) => records.filter((record) => record.url.includes(id));
  return {
    arm(id) {
      assert.equal(heldDoc, null, "a History hold is already armed");
      heldDoc = id;
      heldMessages = [];
    },
    heldCount() {
      return heldMessages.length;
    },
    release() {
      heldDoc = null;
      const messages = heldMessages;
      heldMessages = [];
      for (const held of messages) held.route.send(held.message);
    },
    disconnectHeld(id) {
      heldDoc = null;
      heldMessages = [];
      matching(id).at(-1).close();
    },
    editCount(id) {
      return matching(id).reduce((sum, record) => sum + record.edits, 0);
    },
    connectionCount(id) {
      return matching(id).length;
    },
    historyCount(id) {
      return matching(id).reduce((sum, record) => sum + record.histories, 0);
    },
    dropHistoryOnNextConnection(id) {
      dropNextHistoryDoc = id;
    },
    droppedHistoryCount(id) {
      return matching(id).filter((record) => record.droppedHistory).length;
    },
  };
}

try {
  const pageId = `singleblock${Date.now()}`;
  const manifest = {
    version: 1,
    title: "single-block-acceptance",
    compactHeights: true,
    blocks,
  };
  await seedText(`page:${pageId}:manifest`, JSON.stringify(manifest));
  await Promise.all([
    seedText(docId(pageId, "aaaaaa"), alphaSeed),
    seedText(docId(pageId, "bbbbbb"), betaSeed),
    seedText(docId(pageId, "cccccc"), gammaSeed),
  ]);
  await waitForManifest(
    pageId,
    (value) => value.blocks?.length === 3 && value.blocks[2].collapsed === true,
    "server never received the seeded manifest",
  );

  const first = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  await first.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  const probe = await installWebSocketProbe(first);
  const page = await openWorkspace(first, pageId);

  assert.equal(
    await page.getByLabel("Block presentation").inputValue(),
    "single",
  );
  assert.equal(
    await page.locator("[data-block-scroll]").getAttribute("data-presentation"),
    "single",
  );
  assert.equal(await currentBlockId(page), "aaaaaa");
  assert.equal(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      presentationKey(pageId),
    ),
    null,
  );
  console.log(
    "PASS default: a page with no device preference opens in single mode",
  );

  await selectPresentation(page, "stacked");
  assert.equal(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      presentationKey(pageId),
    ),
    "stacked",
  );
  await page.reload();
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.getByText("(3 blocks)", { exact: true }).waitFor();
  await page.waitForFunction(
    () => window.monaco?.editor.getEditors().length === 3,
  );
  assert.equal(
    await page.getByLabel("Block presentation").inputValue(),
    "stacked",
  );
  assert.equal(await currentBlockId(page), "aaaaaa");
  console.log(
    "PASS early reload: the device's stacked preference survives reload",
  );

  const manifestBeforeSingleReveal = await fetchManifest(pageId);
  const seededLayout = layoutFields(manifestBeforeSingleReveal);
  assert.deepEqual(await bodyState(page, "aaaaaa"), {
    bodyVisibility: "visible",
    panelVisibility: "visible",
    bodyHeight: 260,
    bodyWidth: (await bodyState(page, "aaaaaa")).bodyWidth,
  });
  assert.equal((await bodyState(page, "cccccc")).bodyVisibility, "hidden");
  assert.equal((await bodyState(page, "cccccc")).bodyHeight, 333);
  await selectPresentation(page, "single");
  await selectBlock(page, "cccccc");
  const singleGamma = await bodyState(page, "cccccc");
  assert.equal(singleGamma.bodyVisibility, "visible");
  assert.equal(singleGamma.panelVisibility, "visible");
  assert.ok(singleGamma.bodyHeight > 400, JSON.stringify(singleGamma));
  assert.ok(singleGamma.bodyWidth > 500, JSON.stringify(singleGamma));
  assert.notEqual(singleGamma.bodyHeight, 333);
  assert.equal((await bodyState(page, "aaaaaa")).bodyVisibility, "hidden");
  assert.ok((await bodyState(page, "aaaaaa")).bodyHeight > 400);
  const gammaPanel = page.locator('[data-block-panel="cccccc"]');
  await gammaPanel.locator('input[value="Gamma"]').waitFor();
  assert.equal(await gammaPanel.locator("select").inputValue(), "plaintext");
  await gammaPanel.getByLabel("Copy block content").waitFor();
  await gammaPanel.getByLabel("Export block").waitFor();
  assert.equal(await gammaPanel.locator('[title="Drag to resize"]').count(), 0);
  assert.deepEqual(
    await fetchManifest(pageId),
    manifestBeforeSingleReveal,
    "showing a collapsed block in single mode rewrote the shared manifest",
  );
  await selectPresentation(page, "stacked");
  assert.equal((await bodyState(page, "cccccc")).bodyVisibility, "hidden");
  assert.equal((await bodyState(page, "cccccc")).bodyHeight, 333);
  assert.deepEqual(layoutFields(await fetchManifest(pageId)), seededLayout);
  assert.equal(await currentBlockId(page), "cccccc");
  console.log(
    "PASS layout: single ignores whole-block collapse/height; stacked restores both without manifest writes",
  );

  await selectPresentation(page, "single");
  await selectBlock(page, "aaaaaa");
  await page.evaluate((pageId) => {
    const entries = window.monaco.editor
      .getEditors()
      .map((editor) => [
        editor.getModel().uri.toString(),
        editor,
        editor.getModel(),
      ]);
    if (entries.length !== 3)
      throw new Error(`expected 3 editors, got ${entries.length}`);
    window.__singleBlockIdentities = new Map(
      entries.map(([uri, editor, model]) => [uri, { editor, model }]),
    );
    for (const id of ["aaaaaa", "bbbbbb", "cccccc"]) {
      if (
        !window.__singleBlockIdentities.has(`rustpad-block://${pageId}/${id}`)
      ) {
        throw new Error(`missing editor for ${id}`);
      }
    }
  }, pageId);

  const second = await browser.newContext({
    viewport: { width: 1180, height: 720 },
    acceptDownloads: true,
  });
  await second.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  const peer = await openWorkspace(second, pageId);
  await selectPresentation(peer, "stacked");
  await selectBlock(peer, "cccccc");
  assert.equal(
    await page.getByLabel("Block presentation").inputValue(),
    "single",
  );
  assert.equal(await currentBlockId(page), "aaaaaa");
  assert.equal(
    await peer.getByLabel("Block presentation").inputValue(),
    "stacked",
  );
  assert.equal(await currentBlockId(peer), "cccccc");
  const independentManifest = await fetchManifest(pageId);
  assert.equal(independentManifest.presentation, undefined);
  assert.equal(independentManifest.currentBlockId, undefined);
  console.log("PASS devices: presentation and current block stay device-local");

  await page.evaluate((pageId) => {
    const uri = `rustpad-block://${pageId}/aaaaaa`;
    const editor = window.monaco.editor
      .getEditors()
      .find((candidate) => candidate.getModel().uri.toString() === uri);
    const body = document.querySelector('[data-block-body="aaaaaa"]');
    const trace = [];
    let lastVisibility = getComputedStyle(body).visibility;
    editor.onDidCompositionStart(() => trace.push("compositionstart"));
    editor.onDidCompositionEnd(() => trace.push("compositionend"));
    new MutationObserver(() => {
      const next = getComputedStyle(body).visibility;
      if (next !== lastVisibility) {
        lastVisibility = next;
        trace.push(`visibility:${next}`);
      }
    }).observe(body, { attributes: true, attributeFilter: ["class", "style"] });
    editor.setPosition(editor.getModel().getFullModelRange().getEndPosition());
    editor.focus();
    window.__singleBlockCompositionTrace = trace;
  }, pageId);
  const cdp = await first.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "候选",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await page.waitForFunction(() =>
    window.__singleBlockCompositionTrace.includes("compositionstart"),
  );
  await page.evaluate(() => {
    document
      .querySelector('nav[aria-label="Blocks"] [data-block-id="bbbbbb"]')
      .click();
  });
  await page.waitForFunction(() =>
    window.__singleBlockCompositionTrace.includes("compositionend"),
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-block-body="aaaaaa"]'))
        .visibility === "hidden",
  );
  const compositionTrace = await page.evaluate(
    () => window.__singleBlockCompositionTrace,
  );
  assert.ok(
    compositionTrace.indexOf("compositionend") <
      compositionTrace.indexOf("visibility:hidden"),
    JSON.stringify(compositionTrace),
  );
  await waitForEditorValue(peer, pageId, "aaaaaa", "候选");
  await cdp.detach();
  console.log(
    "PASS Chromium composition: programmatic switch commits text before hiding; peer receives it",
  );

  await selectBlock(page, "aaaaaa");
  const targetDoc = docId(pageId, "aaaaaa");
  const editsBeforeHold = probe.editCount(targetDoc);
  probe.arm(targetDoc);
  await appendToEditor(page, pageId, "aaaaaa", "\nPENDING-ONE", "pending-one");
  await waitUntil(
    () => probe.heldCount() >= 1,
    "the first edit acknowledgement was not held",
  );
  assert.equal(probe.editCount(targetDoc), editsBeforeHold + 1);
  await appendToEditor(page, pageId, "aaaaaa", "\nPENDING-TWO", "pending-two");
  await page.waitForTimeout(250);
  assert.equal(
    probe.editCount(targetDoc),
    editsBeforeHold + 1,
    "the buffered edit was sent before the outstanding edit was acknowledged",
  );
  assert.match(
    await editorValue(page, pageId, "aaaaaa"),
    /PENDING-ONE[\s\S]*PENDING-TWO/,
  );

  await page.evaluate(() =>
    navigator.clipboard.writeText("clipboard-sentinel"),
  );
  await clickUserAction(
    page
      .locator('[data-block-panel="aaaaaa"]')
      .getByLabel("Copy block content"),
    "current-block copy while edits are unacknowledged",
  );
  await page.waitForTimeout(300);
  assert.equal(await readClipboard(page), "clipboard-sentinel");
  const stateBeforeSwitch = await page.evaluate((pageId) => {
    const editor = window.monaco.editor
      .getEditors()
      .find(
        (candidate) =>
          candidate.getModel().uri.toString() ===
          `rustpad-block://${pageId}/aaaaaa`,
      );
    editor.setPosition({ lineNumber: 30, column: 12 });
    editor.setScrollTop(260);
    return { position: editor.getPosition(), scrollTop: editor.getScrollTop() };
  }, pageId);
  assert.ok(stateBeforeSwitch.scrollTop > 100);
  await selectBlock(page, "bbbbbb");
  await selectPresentation(page, "stacked");
  await selectPresentation(page, "single");
  await selectBlock(page, "aaaaaa");
  assert.equal(
    await page.evaluate((pageId) => {
      for (const [uri, identity] of window.__singleBlockIdentities) {
        const editor = window.monaco.editor
          .getEditors()
          .find((candidate) => candidate.getModel().uri.toString() === uri);
        if (
          editor !== identity.editor ||
          editor?.getModel() !== identity.model
        ) {
          return false;
        }
      }
      return window.monaco.editor.getEditors().length === 3;
    }, pageId),
    true,
  );
  const stateAfterSwitch = await page.evaluate((pageId) => {
    const editor = window.monaco.editor
      .getEditors()
      .find(
        (candidate) =>
          candidate.getModel().uri.toString() ===
          `rustpad-block://${pageId}/aaaaaa`,
      );
    return { position: editor.getPosition(), scrollTop: editor.getScrollTop() };
  }, pageId);
  assert.deepEqual(stateAfterSwitch.position, {
    lineNumber: stateBeforeSwitch.position.lineNumber,
    column: stateBeforeSwitch.position.column,
  });
  assert.ok(
    Math.abs(stateAfterSwitch.scrollTop - stateBeforeSwitch.scrollTop) <= 2,
  );
  probe.release();
  await waitUntil(
    () => probe.editCount(targetDoc) === editsBeforeHold + 2,
    "the buffered edit was not sent after releasing the first acknowledgement",
  );
  await waitForEditorValue(peer, pageId, "aaaaaa", "PENDING-TWO");
  const alphaAfterPending = await editorValue(page, pageId, "aaaaaa");
  await waitUntil(
    async () => (await readClipboard(page)) === alphaAfterPending,
    "copy did not resume with the fully acknowledged local text",
  );
  await waitForToastToClose(page, "Copied!");
  console.log(
    "PASS pending edits: outstanding+buffer survive block/presentation switches; copy waits for acknowledgement",
  );

  await appendToEditor(page, pageId, "aaaaaa", "\nUNDO-SURVIVES", "undo-proof");
  await waitForEditorValue(peer, pageId, "aaaaaa", "UNDO-SURVIVES");
  await selectBlock(page, "bbbbbb");
  await selectPresentation(page, "stacked");
  await selectPresentation(page, "single");
  await selectBlock(page, "aaaaaa");
  await page.evaluate((pageId) => {
    const editor = window.monaco.editor
      .getEditors()
      .find(
        (candidate) =>
          candidate.getModel().uri.toString() ===
          `rustpad-block://${pageId}/aaaaaa`,
      );
    editor.focus();
  }, pageId);
  await page.keyboard.press("Control+z");
  await page.waitForFunction(
    ({ pageId }) => {
      const uri = `rustpad-block://${pageId}/aaaaaa`;
      return !window.monaco.editor
        .getEditors()
        .find((candidate) => candidate.getModel().uri.toString() === uri)
        .getValue()
        .includes("UNDO-SURVIVES");
    },
    { pageId },
  );
  assert.equal(await editorValue(page, pageId, "aaaaaa"), alphaAfterPending);
  assert.equal(await editorValue(page, pageId, "bbbbbb"), betaSeed);
  await page.keyboard.press("Control+y");
  await waitForEditorValue(peer, pageId, "aaaaaa", "UNDO-SURVIVES");
  console.log(
    "PASS editor state: editor/model identities, caret, scroll, undo and redo survive switches",
  );

  await appendToEditor(peer, pageId, "bbbbbb", "\nREMOTE-BETA", "remote-beta");
  await waitForEditorValue(page, pageId, "bbbbbb", "REMOTE-BETA");
  assert.equal(await currentBlockId(page), "aaaaaa");
  const beforeCopyConnections = Object.fromEntries(
    blocks.map((block) => [
      block.id,
      probe.connectionCount(docId(pageId, block.id)),
    ]),
  );
  const beforeCopyHistories = Object.fromEntries(
    blocks.map((block) => [
      block.id,
      probe.historyCount(docId(pageId, block.id)),
    ]),
  );
  const expectedAll = (
    await Promise.all(
      blocks.map((block) => editorValue(page, pageId, block.id)),
    )
  ).join("\n\n");
  const exportAllButton = page.getByRole("button", {
    name: "Export",
    exact: true,
  });
  const copyAllButton = exportAllButton
    .locator("xpath=..")
    .getByRole("button", { name: "Copy", exact: true });
  await clickUserAction(copyAllButton, "sidebar copy-all");
  await waitUntil(
    async () => (await readClipboard(page)) === expectedAll,
    "copy-all did not return every current block",
  );
  for (const block of blocks) {
    const id = docId(pageId, block.id);
    assert.ok(probe.connectionCount(id) > beforeCopyConnections[block.id]);
    assert.ok(probe.historyCount(id) > beforeCopyHistories[block.id]);
  }
  assert.match(await readClipboard(page), /REMOTE-BETA/);
  console.log(
    "PASS copy-all: fresh History reads include a remote edit to a non-current block",
  );
  await waitForToastToClose(page, "Copied!");

  await page.evaluate(() => navigator.clipboard.writeText("must-not-be-stale"));
  const beforeFailedConnections = probe.connectionCount(targetDoc);
  probe.dropHistoryOnNextConnection(targetDoc);
  await clickUserAction(
    page
      .locator('[data-block-panel="aaaaaa"]')
      .getByLabel("Copy block content"),
    "current-block copy whose fresh read will time out",
  );
  await waitUntil(
    () => probe.connectionCount(targetDoc) > beforeFailedConnections,
    "failed-copy headless reader did not connect",
  );
  await page
    .getByText("Copy failed", { exact: true })
    .waitFor({ timeout: 12000 });
  assert.equal(probe.droppedHistoryCount(targetDoc), 1);
  assert.equal(await readClipboard(page), "must-not-be-stale");
  console.log(
    "PASS copy failure: a timed-out fresh read reports failure and preserves the clipboard",
  );
  await waitForToastToClose(page, "Copy failed");

  await selectBlock(page, "bbbbbb");
  const betaValue = await editorValue(page, pageId, "bbbbbb");
  const blockDownloadPromise = page.waitForEvent("download");
  await clickUserAction(
    page.locator('[data-block-panel="bbbbbb"]').getByLabel("Export block"),
    "current-block export",
  );
  const blockDownload = await blockDownloadPromise;
  assert.equal(blockDownload.suggestedFilename(), "Beta.txt");
  assert.equal(await streamText(blockDownload), betaValue);

  const currentValues = await Promise.all(
    blocks.map((block) => editorValue(page, pageId, block.id)),
  );
  const allDownloadPromise = page.waitForEvent("download");
  await clickUserAction(exportAllButton, "sidebar export-all");
  const allDownload = await allDownloadPromise;
  assert.equal(allDownload.suggestedFilename(), `${pageId}.md`);
  const allText = await streamText(allDownload);
  blocks.forEach((block, index) => {
    assert.match(
      allText,
      new RegExp(`// === ${block.title} \\(${block.language}\\) ===`),
    );
    assert.ok(allText.includes(currentValues[index]));
  });
  console.log(
    "PASS export: block download has block scope; page download has all-block scope",
  );

  await selectBlock(page, "aaaaaa");
  await page.evaluate(async (pageId) => {
    const editor = window.monaco.editor
      .getEditors()
      .find(
        (candidate) =>
          candidate.getModel().uri.toString() ===
          `rustpad-block://${pageId}/aaaaaa`,
      );
    await editor.getAction("editor.unfoldAll").run();
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.focus();
    await editor.getContribution("editor.contrib.folding").getFoldingModel();
    await editor.getAction("editor.fold").run();
  }, pageId);
  await page.waitForFunction((pageId) => {
    const editor = window.monaco.editor
      .getEditors()
      .find(
        (candidate) =>
          candidate.getModel().uri.toString() ===
          `rustpad-block://${pageId}/aaaaaa`,
      );
    return editor._getViewModel().getHiddenAreas().length > 0;
  }, pageId);
  await waitForManifest(
    pageId,
    (value) =>
      value.blocks.find((block) => block.id === "aaaaaa")?.folds != null,
    "internal fold memory was not persisted",
  );
  await selectPresentation(page, "stacked");
  await selectPresentation(page, "single");
  assert.ok(
    await page.evaluate((pageId) => {
      const editor = window.monaco.editor
        .getEditors()
        .find(
          (candidate) =>
            candidate.getModel().uri.toString() ===
            `rustpad-block://${pageId}/aaaaaa`,
        );
      return editor._getViewModel().getHiddenAreas().length;
    }, pageId),
  );
  await page.reload();
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.getByText("(3 blocks)", { exact: true }).waitFor();
  await page.waitForFunction(
    () => window.monaco?.editor.getEditors().length === 3,
  );
  assert.equal(
    await page.getByLabel("Block presentation").inputValue(),
    "single",
  );
  assert.equal(await currentBlockId(page), "aaaaaa");
  await page.waitForFunction((pageId) => {
    const editor = window.monaco.editor
      .getEditors()
      .find(
        (candidate) =>
          candidate.getModel().uri.toString() ===
          `rustpad-block://${pageId}/aaaaaa`,
      );
    return editor._getViewModel().getHiddenAreas().length > 0;
  }, pageId);
  console.log(
    "PASS folds: internal folding survives presentation changes and reload",
  );

  await peer.getByLabel("Toggle block").nth(2).click();
  await waitForManifest(
    pageId,
    (value) =>
      value.blocks.find((block) => block.id === "cccccc")?.collapsed === false,
    "peer layout change did not reach the shared manifest",
  );
  assert.equal(
    await page.getByLabel("Block presentation").inputValue(),
    "single",
  );
  await peer.getByLabel("Toggle block").nth(2).click();
  await waitForManifest(
    pageId,
    (value) =>
      value.blocks.find((block) => block.id === "cccccc")?.collapsed === true,
    "peer layout restoration did not reach the shared manifest",
  );
  console.log(
    "PASS shared state: peer layout changes sync without changing presentation choice",
  );

  for (const block of blocks) {
    assert.equal(
      await fetchText(docId(pageId, block.id)),
      await editorValue(page, pageId, block.id),
      `server text differs for ${block.id}`,
    );
  }
  console.log(
    "PASS server: direct full reads match all three live Monaco models",
  );

  await selectBlock(page, "bbbbbb");
  await peer
    .locator('[data-block-panel="bbbbbb"]')
    .getByLabel("Remove block")
    .click();
  await peer.locator("[data-confirm-delete-block]").click();
  await page.getByText("(2 blocks)", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('nav[aria-label="Blocks"] [aria-current="true"]')
        ?.getAttribute("data-block-id") === "cccccc",
  );
  assert.equal(await currentBlockId(page), "cccccc");
  assert.equal(await page.locator('[data-block-panel="bbbbbb"]').count(), 0);
  console.log(
    "PASS remote deletion: deleting the current block selects its following sibling",
  );

  const gammaDoc = docId(pageId, "cccccc");

  async function monitorClientCalls(target) {
    await target.evaluate(async () => {
      const moduleUrl = performance
        .getEntriesByType("resource")
        .find(
          (entry) => new URL(entry.name).pathname === "/src/rustpad.ts",
        ).name;
      const { default: Rustpad } = await import(moduleUrl);
      window.__disconnectResults = { sync: [], close: [] };
      for (const [method, results] of [
        ["waitForSync", window.__disconnectResults.sync],
        ["dispose", window.__disconnectResults.close],
      ]) {
        const original = Rustpad.prototype[method];
        Rustpad.prototype[method] = function () {
          const result = { status: "pending" };
          results.push(result);
          return original.call(this).then(
            () => {
              result.status = "resolved";
            },
            (error) => {
              result.status = error.message;
              throw error;
            },
          );
        };
      }
    });
  }

  const offlineId = `singleoffline${Date.now()}`;
  const offlineDoc = docId(offlineId, "cccccc");
  await seedText(
    `page:${offlineId}:manifest`,
    JSON.stringify({ version: 1, compactHeights: true, blocks: [blocks[2]] }),
  );
  await seedText(offlineDoc, "offline baseline");
  const offlineContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await offlineContext.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  let holdEdit = false;
  let heldEdits = 0;
  let offlineSocket;
  await offlineContext.routeWebSocket(/\/api\/socket\/.*:block:/, (route) => {
    const server = route.connectToServer();
    offlineSocket = { route, server };
    route.onMessage((message) => {
      if (holdEdit && JSON.parse(String(message)).Edit !== undefined) {
        heldEdits += 1;
        return;
      }
      server.send(message);
    });
  });
  const offlinePage = await openWorkspace(offlineContext, offlineId, 1);
  await waitForEditorValue(
    offlinePage,
    offlineId,
    "cccccc",
    "offline baseline",
  );
  await monitorClientCalls(offlinePage);
  holdEdit = true;
  await appendToEditor(
    offlinePage,
    offlineId,
    "cccccc",
    "\nOFFLINE-UNCONFIRMED",
    "offline-proof",
  );
  await waitUntil(
    () => heldEdits === 1,
    "offline check did not hold an unacknowledged edit",
  );
  await offlinePage.evaluate((id) => {
    window.__blockedConnections = 0;
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args) {
        if (!String(args[0]).includes(id))
          return Reflect.construct(target, args);
        window.__blockedConnections += 1;
        return {
          readyState: target.CONNECTING,
          close() {
            this.readyState = target.CLOSED;
            this.onclose?.();
          },
          send() {
            throw new Error("The blocked socket has not connected");
          },
        };
      },
    });
  }, offlineDoc);
  offlineSocket.server.close();
  offlineSocket.route.close();
  await offlinePage.waitForFunction(() => window.__blockedConnections > 0);
  await offlinePage.evaluate(() =>
    navigator.clipboard.writeText("offline-sentinel"),
  );
  await clickUserAction(
    offlinePage.getByLabel("Copy block content"),
    "copy while reconnection remains blocked",
  );
  await offlinePage
    .getByText("Copy failed", { exact: true })
    .waitFor({ timeout: 12000 });
  await offlinePage
    .getByText(/Copy any unsaved editor text manually, then reload the page/)
    .waitFor();
  assert.equal(await readClipboard(offlinePage), "offline-sentinel");
  assert.match(
    await offlinePage.evaluate(
      () => window.__disconnectResults.sync.at(-1).status,
    ),
    /Timed out/,
  );
  assert.equal(await fetchText(offlineDoc), "offline baseline");
  assert.match(
    await editorValue(offlinePage, offlineId, "cccccc"),
    /OFFLINE-UNCONFIRMED/,
  );
  console.log(
    "PASS unrecovered disconnect: blocked reconnect makes copy fail with manual-save guidance and preserves the clipboard",
  );
  await offlineContext.close();

  await monitorClientCalls(page);
  probe.arm(gammaDoc);
  await appendToEditor(
    page,
    pageId,
    "cccccc",
    "\nUNCONFIRMED",
    "disconnect-proof",
  );
  await waitUntil(
    () => probe.heldCount() > 0,
    "disconnect proof did not hold an acknowledgement",
  );
  await page.evaluate(() =>
    navigator.clipboard.writeText("disconnect-sentinel"),
  );
  const gammaCopy = page
    .locator('[data-block-panel="cccccc"]')
    .getByLabel("Copy block content");
  await clickUserAction(gammaCopy, "copy before disconnect");
  await page.waitForFunction(
    () => window.__disconnectResults.sync.length === 1,
  );
  assert.equal(
    await page.evaluate(() => window.__disconnectResults.sync[0].status),
    "pending",
  );
  const connectionsBeforeDrop = probe.connectionCount(gammaDoc);
  probe.disconnectHeld(gammaDoc);
  await page.getByText("Copy failed", { exact: true }).waitFor();
  assert.match(
    await page.evaluate(() => window.__disconnectResults.sync[0].status),
    /closed before.*acknowledged/,
  );
  assert.equal(await readClipboard(page), "disconnect-sentinel");
  await waitForToastToClose(page, "Copy failed");
  await waitUntil(
    () => probe.connectionCount(gammaDoc) > connectionsBeforeDrop,
    "the editor did not reconnect",
  );
  await clickUserAction(gammaCopy, "copy after an unconfirmed disconnect");
  await page.waitForFunction(
    () =>
      window.__disconnectResults.sync.length === 2 &&
      window.__disconnectResults.sync[1].status !== "pending",
  );
  assert.equal(
    await page.evaluate(() => window.__disconnectResults.sync[1].status),
    "resolved",
    "a fresh copy after reconnect must succeed",
  );
  const recoveredText = await editorValue(page, pageId, "cccccc");
  assert.match(recoveredText, /UNCONFIRMED/);
  await waitUntil(
    async () => (await readClipboard(page)) === recoveredText,
    "recovered copy did not return the current text including the unacknowledged edit",
  );
  await waitForToastToClose(page, "Copied!");
  const closeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") closeErrors.push(message.text());
  });
  await page
    .getByRole("button", { name: "Back to Document", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.__disconnectResults.close.length === 2 &&
      window.__disconnectResults.close.every(
        (result) => result.status !== "pending",
      ),
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.__disconnectResults.close.map((result) => result.status),
    ),
    ["resolved", "resolved"],
  );
  assert.equal(
    await page.getByText("Block sync failed", { exact: true }).count(),
    0,
  );
  assert.equal(
    closeErrors.some((error) =>
      error.includes("Failed to close block connection"),
    ),
    false,
  );
  console.log(
    "PASS recovered disconnect: in-flight copy fails without changing the clipboard; fresh copy includes pending text and clean unmount succeeds",
  );

  const emptyId = `singleempty${Date.now()}`;
  await seedText(
    `page:${emptyId}:manifest`,
    JSON.stringify({ version: 1, compactHeights: true, blocks: [] }),
  );
  const emptyContext = await browser.newContext({
    viewport: { width: 900, height: 600 },
  });
  const emptyPage = await openWorkspace(emptyContext, emptyId, 0);
  assert.equal(
    await emptyPage.getByLabel("Block presentation").inputValue(),
    "single",
  );
  assert.equal(
    await emptyPage.locator('nav[aria-label="Blocks"] [data-block-id]').count(),
    0,
  );
  assert.equal(await currentBlockId(emptyPage), null);
  await emptyPage
    .getByRole("button", { name: "Add Block", exact: true })
    .waitFor();
  await emptyPage.waitForTimeout(400);
  assert.deepEqual((await fetchManifest(emptyId)).blocks, []);
  console.log(
    "PASS empty manifest: single mode offers Add Block without auto-creating one",
  );

  await emptyContext.close();
  await second.close();
  await first.close();
} finally {
  await browser.close();
}
