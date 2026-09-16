/**
 * Prerequisites for `npm run test:browser`:
 * - Run `npm ci` to install playwright-core. PLAYWRIGHT_MODULE may point to an
 *   alternate Playwright module specifier or absolute module path.
 * - Start the dev server with `npm run dev`. RUSTPAD_URL selects its URL
 *   (default: http://127.0.0.1:5173).
 * - Start the backend with `PORT=3030 cargo run -p rustpad-server` on
 *   127.0.0.1:3030, the /api proxy target in vite.config.ts. RUSTPAD_URL selects
 *   the frontend; it does not override that backend target.
 * - Install Chromium with `npx playwright-core install chromium`, or set
 *   CHROMIUM_PATH to the absolute path of an existing Chromium executable.
 */
import assert from "node:assert/strict";

const base = process.env.RUSTPAD_URL || "http://127.0.0.1:5173";

try {
  const response = await fetch(base, { signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(
    `Cannot reach ${base}. The dev server must be running; start npm run dev or set RUSTPAD_URL.`,
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
  console.error(
    "Cannot load Playwright. Run npm ci to install playwright-core, or set PLAYWRIGHT_MODULE to an available module.",
    error,
  );
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
    "A Chromium binary was not found or could not be launched. Set CHROMIUM_PATH to a Chromium executable, or run npx playwright-core install chromium.",
    error,
  );
  process.exit(1);
}

const blocks = ["aaaaaa", "bbbbbb", "cccccc", "dddddd"].map((id, index) => ({
  id,
  title: ["Alpha", "Beta", "Gamma", "Delta"][index],
  language: "plaintext",
  height: 200,
}));
const blockDoc = (pageId, id) => `page:${pageId}:block:${id}`;
const manifestDoc = (pageId) => `page:${pageId}:manifest`;
const row = (page, id) =>
  page.locator(`nav[aria-label="Blocks"] [data-block-id="${id}"]`);

async function fetchText(id) {
  const response = await fetch(new URL(`api/text/${id}`, base));
  assert.equal(response.ok, true, `read ${id}: HTTP ${response.status}`);
  return response.text();
}

async function seedText(id, text) {
  const url = new URL(`api/socket/${id}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`seed timeout: ${id}`)),
        8000,
      );
      let sent = false;
      ws.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.History === undefined) return;
          if (!sent) {
            assert.deepEqual(message.History.operations, []);
            sent = true;
            ws.send(
              JSON.stringify({ Edit: { revision: 0, operation: [text] } }),
            );
          } else {
            clearTimeout(timer);
            resolve();
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      ws.addEventListener("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    ws.close();
  }
}

async function waitForValue(read, expected, message) {
  let actual;
  const started = Date.now();
  while (Date.now() - started < 10000) {
    actual = await read();
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(actual, expected, message);
}

async function seedPage(
  name,
  entries = blocks.slice(0, 3),
  bodies = {},
  marker = true,
) {
  const id = `integrated-${name}-${Date.now()}`;
  await seedText(
    manifestDoc(id),
    JSON.stringify({
      version: 1,
      title: name,
      ...(marker ? { compactHeights: true } : {}),
      blocks: entries,
    }),
  );
  for (const [blockId, text] of Object.entries(bodies)) {
    await seedText(blockDoc(id, blockId), text);
  }
  return id;
}

async function newContext(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...options,
  });
  await context.addInitScript(() => {
    window.integratedEditor = (id) => {
      const editors = window.monaco?.editor.getEditors() ?? [];
      const editor =
        id === null
          ? editors[0]
          : editors.find((entry) =>
              entry.getModel()?.uri.toString().endsWith(`/${id}`),
            );
      if (!editor) throw new Error(`missing editor: ${id}`);
      return editor;
    };
  });
  return context;
}

async function ready(page, count) {
  if (page.viewportSize().width < 480) {
    // ConnectionStatus is absent while the phone sidebar is collapsed.
    await page
      .locator(
        '[data-block-scroll] button:has-text("Add Block"):not([disabled])',
      )
      .first()
      .waitFor();
  } else {
    await page.getByText("You are connected!", { exact: true }).waitFor();
  }
  await page
    .getByText(`(${count} block${count === 1 ? "" : "s"})`, { exact: true })
    .waitFor();
  await page.waitForFunction(
    (count) => window.monaco?.editor.getEditors().length === count,
    count,
  );
}

async function openPage(context, id, count = 3) {
  const page = await context.newPage();
  await page.goto(`${base}/#page:${id}`);
  await ready(page, count);
  return page;
}

async function ids(page) {
  return page
    .locator('nav[aria-label="Blocks"] [data-block-id]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-block-id")),
    );
}

async function current(page) {
  return page
    .locator('nav[aria-label="Blocks"] [aria-current="true"]')
    .evaluateAll(
      (elements) => elements[0]?.getAttribute("data-block-id") ?? null,
    );
}

async function selectBlock(page, id) {
  await row(page, id).click();
  await waitForValue(
    () => current(page),
    id,
    "sidebar selection did not take effect",
  );
}

async function presentation(page, value) {
  await page.getByLabel("Block presentation").selectOption(value);
  await waitForValue(
    () => page.locator("[data-block-scroll]").getAttribute("data-presentation"),
    value,
    "presentation did not change",
  );
}

async function choices(page, id, mode) {
  assert.equal(
    await current(page),
    id,
    "shared change moved the current block",
  );
  assert.equal(await page.getByLabel("Block presentation").inputValue(), mode);
  assert.equal(
    await page.locator("[data-block-scroll]").getAttribute("data-presentation"),
    mode,
  );
}

async function editorState(page, id) {
  return page.evaluate((id) => {
    const editor = window.integratedEditor(id);
    return {
      text: editor.getValue(),
      position: { ...editor.getPosition() },
      scrollTop: editor.getScrollTop(),
      hidden: editor
        ._getViewModel()
        .getHiddenAreas()
        .map((range) => [range.startLineNumber, range.endLineNumber]),
    };
  }, id);
}

async function textIs(page, id, expected) {
  await waitForValue(
    async () => (await editorState(page, id)).text,
    expected,
    `wrong body for ${id}`,
  );
}

async function focusEnd(page, id) {
  await page.evaluate((id) => {
    const editor = window.integratedEditor(id);
    editor.setPosition(editor.getModel().getFullModelRange().getEndPosition());
    editor.pushUndoStop();
    editor.focus();
  }, id);
}

async function typeSuffix(page, id, text) {
  await focusEnd(page, id);
  await page.keyboard.type(text);
  await page.evaluate((id) => window.integratedEditor(id).pushUndoStop(), id);
}

async function openBlockMenu(page, id) {
  await page.locator(`[data-sidebar-block-menu="${id}"]`).click();
  await page.locator(`[data-block-language="${id}"]`).waitFor();
}

async function closeBlockMenu(page) {
  await page.keyboard.press("Escape");
  await page.locator("[data-sidebar-menu]").waitFor({ state: "detached" });
}

async function setBlockLanguage(page, id, language) {
  await openBlockMenu(page, id);
  await page.locator(`[data-block-language="${id}"]`).selectOption(language);
  await closeBlockMenu(page);
}

async function blockLanguage(page, id) {
  await openBlockMenu(page, id);
  const value = await page
    .locator(`[data-block-language="${id}"]`)
    .inputValue();
  await closeBlockMenu(page);
  return value;
}

async function moveMenu(page, id, direction) {
  await page.locator(`[data-sidebar-block-menu="${id}"]`).click();
  await page.locator(`[data-sidebar-move="${id}:${direction}"]`).click();
}

async function dragBefore(page, moved, target) {
  const handle = page.locator(`[data-sidebar-drag-handle="${moved}"]`);
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const to = await page.locator(`[data-block-row="${target}"]`).boundingBox();
  assert.ok(from && to, "drag endpoints must exist");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 16 });
  await page
    .locator(`[data-sidebar-drop-indicator][data-insert-before="${target}"]`)
    .waitFor();
  await page.mouse.up();
  await page
    .locator("[data-sidebar-drop-indicator]")
    .waitFor({ state: "hidden" });
}

async function removeBlock(page, id) {
  await openBlockMenu(page, id);
  await page.locator(`[data-sidebar-remove-block="${id}"]`).click();
  await page.locator("[data-delete-block-dialog]").waitFor();
  await page.locator("[data-confirm-delete-block]").click();
  await page.locator("[data-delete-block-dialog]").waitFor({ state: "hidden" });
  await row(page, id).waitFor({ state: "detached" });
}

async function manifest(id) {
  return JSON.parse(await fetchText(manifestDoc(id)));
}

async function countManifestEdits(context, id) {
  const edits = [];
  context.on("page", (page) => {
    page.on("websocket", (socket) => {
      if (!decodeURIComponent(socket.url()).endsWith(manifestDoc(id))) return;
      socket.on("framesent", ({ payload }) => {
        const edit = JSON.parse(String(payload)).Edit;
        if (edit) edits.push(edit);
      });
    });
  });
  return edits;
}

async function heightsAre(page, expected) {
  await waitForValue(
    () =>
      page
        .locator("[data-block-body]")
        .evaluateAll((elements) =>
          elements.map((element) =>
            Math.round(element.getBoundingClientRect().height),
          ),
        ),
    expected,
    "rendered heights differ",
  );
}

async function heightMigration() {
  const oldBlocks = blocks
    .slice(0, 3)
    .map((block, index) => ({ ...block, height: [480, 120, 360][index] }));
  const id = await seedPage("heights", oldBlocks, {}, false);
  assert.equal((await manifest(id)).compactHeights, undefined);
  const context = await newContext();
  const edits = await countManifestEdits(context, id);
  const page = await openPage(context, id);
  await waitForValue(
    async () => (await manifest(id)).blocks.map((block) => block.height),
    [200, 200, 200],
    "height migration failed",
  );
  assert.equal((await manifest(id)).compactHeights, true);
  await choices(page, "aaaaaa", "single");
  await presentation(page, "stacked");
  await heightsAre(page, [200, 200, 200]);
  await presentation(page, "single");
  await presentation(page, "stacked");
  await heightsAre(page, [200, 200, 200]);
  const afterSwitches = await manifest(id);
  assert.deepEqual(
    afterSwitches.blocks.map((block) => block.height),
    [200, 200, 200],
  );
  assert.equal(afterSwitches.compactHeights, true);
  const handle = page.locator('[title="Drag to resize"]').first();
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 180, {
    steps: 12,
  });
  await page.mouse.up();
  await heightsAre(page, [380, 200, 200]);
  await waitForValue(
    async () => (await manifest(id)).blocks.map((block) => block.height),
    [380, 200, 200],
    "manual height did not reach server",
  );
  const saved = await manifest(id);
  await page.reload();
  await ready(page, 3);
  await choices(page, "aaaaaa", "stacked");
  await heightsAre(page, [380, 200, 200]);
  const second = await newContext();
  const peerEdits = await countManifestEdits(second, id);
  assert.deepEqual((await second.storageState()).origins, []);
  const peer = await openPage(second, id);
  await choices(peer, "aaaaaa", "single");
  assert.deepEqual(await ids(peer), await ids(page));
  await presentation(peer, "stacked");
  await heightsAre(peer, [380, 200, 200]);
  await presentation(peer, "single");
  await choices(page, "aaaaaa", "stacked");
  assert.deepEqual(await manifest(id), saved);
  const localExtra = edits.length - 2;
  const peerExtra = peerEdits.length;
  console.log(
    `DIAGNOSTIC ticket 10 (10-shared-document-late-seed-doubling.md): manifest doubling extra writes ${localExtra + peerExtra > 0 ? "OBSERVED" : "NOT OBSERVED"} on this run; local extra=${localExtra}, peer extra=${peerExtra} (beyond 2 legitimate local writes and 0 peer writes)`,
  );
  for (const client of [page, peer]) {
    await waitForValue(
      () =>
        client.evaluate((id) => {
          const snapshot = JSON.parse(
            localStorage.getItem(`block-workspace:snapshot:${id}`),
          );
          return {
            marker: snapshot?.compactHeights,
            heights: snapshot?.blocks.map((block) => block.height),
          };
        }, id),
      { marker: true, heights: [380, 200, 200] },
      "snapshot lost migrated heights or marker",
    );
  }
  console.log(
    "PASS integrated heights: one migration across presentations; dragged 380px survives reload and a second browser context with independent storage; blocks shared, presentation local; manifest doubling is a known pre-existing defect (ticket 10)",
  );
  await second.close();
  await context.close();
}

const longBody = (name) =>
  Array.from({ length: 100 }, (_, index) => `${name} line ${index + 1}`).join(
    "\n",
  );

async function rememberIdentity(page, id) {
  await page.evaluate((id) => {
    window.integratedIdentities ??= new Map();
    const editor = window.integratedEditor(id);
    window.integratedIdentities.set(id, { editor, model: editor.getModel() });
  }, id);
}

async function assertIdentities(page) {
  assert.equal(
    await page.evaluate(() =>
      [...window.integratedIdentities].every(([id, saved]) => {
        const editor = window.integratedEditor(id);
        return editor === saved.editor && editor.getModel() === saved.model;
      }),
    ),
    true,
    "sidebar chain replaced a block editor or model",
  );
}

async function parkEditor(page, id) {
  await page.evaluate((id) => {
    const editor = window.integratedEditor(id);
    editor.setPosition({ lineNumber: 25, column: 5 });
    editor.setScrollTop(260, window.monaco.editor.ScrollType.Immediate);
  }, id);
  const state = await editorState(page, id);
  assert.ok(
    state.scrollTop > 100,
    "scroll preservation needs a nonzero initial scroll",
  );
  return state;
}

async function assertRestored(page, id, before) {
  const after = await editorState(page, id);
  assert.equal(after.text, before.text);
  assert.deepEqual(after.position, before.position, `caret lost for ${id}`);
  assert.ok(
    Math.abs(after.scrollTop - before.scrollTop) <= 2,
    `scroll lost for ${id}: ${before.scrollTop} -> ${after.scrollTop}`,
  );
  await assertIdentities(page);
}

async function undoTo(page, id, text) {
  await page.evaluate((id) => window.integratedEditor(id).focus(), id);
  await page.keyboard.press("Control+z");
  await textIs(page, id, text);
}

async function sidebarChain() {
  const beta = longBody("beta");
  const createdBody = longBody("created");
  const id = await seedPage("sidebar-chain", blocks.slice(0, 2), {
    bbbbbb: beta,
  });
  const context = await newContext();
  const page = await openPage(context, id, 2);
  await textIs(page, "bbbbbb", beta);
  await rememberIdentity(page, "bbbbbb");
  await page.locator("[data-sidebar-add-block]").click();
  await ready(page, 3);
  const created = await current(page);
  assert.ok(created && !["aaaaaa", "bbbbbb"].includes(created));
  assert.deepEqual(await ids(page), ["aaaaaa", created, "bbbbbb"]);
  await rememberIdentity(page, created);
  await page.locator(`[data-block-name="${created}"]`).fill("Session notes");
  await choices(page, created, "single");
  await assertIdentities(page);
  await setBlockLanguage(page, created, "javascript");
  await choices(page, created, "single");
  await assertIdentities(page);
  await dragBefore(page, created, "aaaaaa");
  await waitForValue(
    () => ids(page),
    [created, "aaaaaa", "bbbbbb"],
    "handle did not reorder created block",
  );
  await choices(page, created, "single");
  await assertIdentities(page);
  await focusEnd(page, created);
  await page.keyboard.insertText(createdBody);
  await typeSuffix(page, created, " CREATED-END");
  const createdState = await parkEditor(page, created);
  await selectBlock(page, "bbbbbb");
  await typeSuffix(page, "bbbbbb", " BETA-END");
  const betaState = await parkEditor(page, "bbbbbb");
  await selectBlock(page, created);
  await assertRestored(page, created, createdState);
  await selectBlock(page, "bbbbbb");
  await assertRestored(page, "bbbbbb", betaState);
  await undoTo(page, "bbbbbb", beta);
  await textIs(page, created, `${createdBody} CREATED-END`);
  await selectBlock(page, created);
  await assertRestored(page, created, createdState);
  await undoTo(page, created, createdBody);
  await textIs(page, "bbbbbb", beta);
  await textIs(page, "aaaaaa", "");
  await waitForValue(
    () => fetchText(blockDoc(id, created)),
    createdBody,
    "created body not synchronized after undo",
  );
  await waitForValue(
    () => fetchText(blockDoc(id, "bbbbbb")),
    beta,
    "beta body not synchronized after undo",
  );
  const entry = (await manifest(id)).blocks.find(
    (block) => block.id === created,
  );
  assert.equal(entry.title, "Session notes");
  assert.equal(entry.language, "javascript");
  console.log(
    "PASS integrated sidebar chain: create, name, language, handle reorder and switches preserve block/editor/model identities, each body, caret, nonzero scroll and independent undo histories",
  );
  await context.close();
}

const headingBefore =
  "## First\nfirst body\n## Second\nsecond body\n# Tail\ntail body";
const headingFirst =
  "## First\nfirst body\n## \n## Second\nsecond body\n# Tail\ntail body";
const headingSecond =
  "## First\nfirst body\n## \n## Second\nsecond body\n## \n# Tail\ntail body";

async function foldAt(page, id, line) {
  await page.evaluate(
    async ({ id, line }) => {
      const editor = window.integratedEditor(id);
      editor.setPosition({
        lineNumber: line,
        column: editor.getModel().getLineMaxColumn(line),
      });
      editor.focus();
      await editor.getContribution("editor.contrib.folding").getFoldingModel();
      await editor.getAction("editor.fold").run();
    },
    { id, line },
  );
}

async function headingStateIs(page, id, expected) {
  await waitForValue(
    async () => {
      const { text, position, hidden } = await editorState(page, id);
      return { text, position, hidden };
    },
    expected,
    "folded-heading text, caret or hidden lines differ",
  );
}

async function firstHeading(page, peer, id) {
  await foldAt(page, id, 1);
  await waitForValue(
    async () => (await editorState(page, id)).hidden,
    [[2, 2]],
    "first heading did not fold",
  );
  await page.keyboard.press("Enter");
  await headingStateIs(page, id, {
    text: headingFirst,
    position: { lineNumber: 3, column: 4 },
    hidden: [[2, 2]],
  });
  await textIs(peer, id, headingFirst);
}

async function secondHeading(page, peer, id) {
  await foldAt(page, id, 4);
  await waitForValue(
    async () => (await editorState(page, id)).hidden,
    [
      [2, 2],
      [5, 5],
    ],
    "second heading did not fold independently",
  );
  await page.keyboard.press("Enter");
  await headingStateIs(page, id, {
    text: headingSecond,
    position: { lineNumber: 6, column: 4 },
    hidden: [
      [2, 2],
      [5, 5],
    ],
  });
  await textIs(peer, id, headingSecond);
}

async function foldedHeadings() {
  const entries = [{ ...blocks[0], language: "markdown" }, blocks[1]];
  const id = await seedPage("headings", entries, {
    aaaaaa: headingBefore,
    bbbbbb: "other block",
  });
  const context = await newContext();
  const second = await newContext();
  const page = await openPage(context, id, 2);
  const peer = await openPage(second, id, 2);
  await textIs(page, "aaaaaa", headingBefore);
  await textIs(peer, "aaaaaa", headingBefore);
  await choices(page, "aaaaaa", "single");
  await firstHeading(page, peer, "aaaaaa");
  await presentation(page, "stacked");
  await secondHeading(page, peer, "aaaaaa");
  await selectBlock(page, "bbbbbb");
  await selectBlock(page, "aaaaaa");
  await headingStateIs(page, "aaaaaa", {
    text: headingSecond,
    position: { lineNumber: 6, column: 4 },
    hidden: [
      [2, 2],
      [5, 5],
    ],
  });
  await undoTo(page, "aaaaaa", headingFirst);
  await textIs(peer, "aaaaaa", headingFirst);
  await waitForValue(
    async () => (await editorState(page, "aaaaaa")).hidden,
    [
      [2, 2],
      [5, 5],
    ],
    "undo unfolded original bodies",
  );
  await presentation(page, "single");
  await selectBlock(page, "bbbbbb");
  await selectBlock(page, "aaaaaa");
  await undoTo(page, "aaaaaa", headingBefore);
  await textIs(peer, "aaaaaa", headingBefore);
  await textIs(page, "bbbbbb", "other block");
  await second.close();
  await context.close();

  const doc = `integrated-document-${Date.now()}`;
  await seedText(doc, headingBefore);
  const documentContext = await newContext();
  const documentPeerContext = await newContext();
  const documentPage = await documentContext.newPage();
  const documentPeer = await documentPeerContext.newPage();
  for (const client of [documentPage, documentPeer]) {
    await client.goto(`${base}/#${doc}`);
    await client.getByText("You are connected!", { exact: true }).waitFor();
    await client.waitForFunction(
      () => window.monaco?.editor.getEditors().length === 1,
    );
    await textIs(client, null, headingBefore);
  }
  await documentPage.locator("select").first().selectOption("markdown");
  await firstHeading(documentPage, documentPeer, null);
  await secondHeading(documentPage, documentPeer, null);
  await undoTo(documentPage, null, headingFirst);
  await textIs(documentPeer, null, headingFirst);
  await waitForValue(
    async () => (await editorState(documentPage, null)).hidden,
    [
      [2, 2],
      [5, 5],
    ],
    "document undo unfolded original bodies",
  );
  await undoTo(documentPage, null, headingBefore);
  await textIs(documentPeer, null, headingBefore);
  console.log(
    "PASS integrated folded headings: single then stacked, block switches and undo, plus single-document regression; exact sibling level/position, caret after marker space, original hidden lines and text in a second browser context with independent storage",
  );
  await documentPeerContext.close();
  await documentContext.close();
}

async function holdAcknowledgements(context, doc) {
  const state = { armed: false, held: [] };
  await context.routeWebSocket(/\/api\/socket\//, (route) => {
    const server = route.connectToServer();
    const target = decodeURIComponent(route.url()).endsWith(doc);
    server.onMessage((message) => {
      const history = JSON.parse(String(message)).History;
      if (target && state.armed && history?.operations?.length > 0) {
        state.held.push({ route, message });
      } else {
        route.send(message);
      }
    });
  });
  return state;
}

async function typingSwitch() {
  const id = await seedPage("typing-switch", blocks.slice(0, 3), {
    aaaaaa: "alpha:",
    bbbbbb: "beta:",
    cccccc: "gamma:",
  });
  const context = await newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(base).origin,
  });
  const hold = await holdAcknowledgements(context, blockDoc(id, "aaaaaa"));
  const second = await newContext();
  const page = await openPage(context, id);
  const peer = await openPage(second, id);
  await selectBlock(peer, "bbbbbb");
  await textIs(page, "aaaaaa", "alpha:");
  await textIs(peer, "bbbbbb", "beta:");
  await focusEnd(page, "aaaaaa");
  await focusEnd(peer, "bbbbbb");
  hold.armed = true;
  await page.keyboard.type("first-");
  await waitForValue(
    () => hold.held.length > 0,
    true,
    "no outstanding acknowledgement to test",
  );
  const localSuffix = "fast-local-0123456789";
  const peerSuffix = "peer-in-beta-9876543210";
  const results = await Promise.allSettled([
    (async () => {
      await page.keyboard.type(localSuffix);
      await selectBlock(page, "cccccc");
    })(),
    peer.keyboard.type(peerSuffix, { delay: 8 }),
  ]);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  const alpha = `alpha:first-${localSuffix}`;
  const beta = `beta:${peerSuffix}`;
  await textIs(page, "aaaaaa", alpha);
  assert.notEqual(
    await fetchText(blockDoc(id, "aaaaaa")),
    alpha,
    "test must switch while local edits are still buffered",
  );
  await textIs(page, "bbbbbb", beta);
  await choices(page, "cccccc", "single");
  await choices(peer, "bbbbbb", "single");
  const copy = page
    .getByRole("button", { name: "Export", exact: true })
    .locator("xpath=..")
    .getByRole("button", { name: "Copy", exact: true });
  await page.evaluate(() =>
    navigator.clipboard.writeText("integrated-copy-sentinel"),
  );
  await copy.click();
  hold.armed = false;
  for (const message of hold.held.splice(0))
    message.route.send(message.message);
  const expected = [alpha, beta, "gamma:"].join("\n\n");
  await waitForValue(
    () => page.evaluate(() => navigator.clipboard.readText()),
    expected,
    "copy returned lost input, wrong-block text or stale cache",
  );
  for (const client of [page, peer]) {
    await textIs(client, "aaaaaa", alpha);
    await textIs(client, "bbbbbb", beta);
    await textIs(client, "cccccc", "gamma:");
  }
  await selectBlock(page, "aaaaaa");
  await textIs(page, "aaaaaa", alpha);
  await waitForValue(
    () => fetchText(blockDoc(id, "aaaaaa")),
    alpha,
    "server lost local input",
  );
  await waitForValue(
    () => fetchText(blockDoc(id, "bbbbbb")),
    beta,
    "server misplaced peer input",
  );
  console.log(
    "PASS integrated typing/switch: rapid keyboard input with outstanding+buffered edits survives immediate switch while a second browser context edits another block; both exact bodies and copy-all are current",
  );
  await second.close();
  await context.close();
}

async function sharedChanges() {
  const id = await seedPage("shared-changes", blocks);
  const context = await newContext();
  const second = await newContext();
  const page = await openPage(context, id, 4);
  const peer = await openPage(second, id, 4);
  await presentation(peer, "stacked");
  await selectBlock(peer, "bbbbbb");
  const unchanged = async () => {
    await choices(page, "aaaaaa", "single");
    await choices(peer, "bbbbbb", "stacked");
  };
  await moveMenu(page, "dddddd", "top");
  for (const client of [page, peer]) {
    await waitForValue(
      () => ids(client),
      ["dddddd", "aaaaaa", "bbbbbb", "cccccc"],
      "shared reorder did not arrive",
    );
  }
  await unchanged();
  await page.locator('[data-block-name="cccccc"]').fill("Shared gamma");
  await waitForValue(
    () => peer.locator('[data-block-name="cccccc"]').inputValue(),
    "Shared gamma",
    "shared name did not arrive",
  );
  await unchanged();
  await setBlockLanguage(page, "cccccc", "json");
  await waitForValue(
    () => blockLanguage(peer, "cccccc"),
    "json",
    "shared language did not arrive",
  );
  for (const client of [page, peer]) {
    assert.equal(
      await client.evaluate(() =>
        window.integratedEditor("cccccc").getModel().getLanguageId(),
      ),
      "json",
    );
  }
  await unchanged();
  await removeBlock(page, "cccccc");
  await waitForValue(
    () => ids(peer),
    ["dddddd", "aaaaaa", "bbbbbb"],
    "shared non-current deletion did not arrive",
  );
  await unchanged();
  await removeBlock(page, "bbbbbb");
  await waitForValue(
    () => ids(peer),
    ["dddddd", "aaaaaa"],
    "peer-current deletion did not arrive",
  );
  await waitForValue(
    () => current(peer),
    "aaaaaa",
    "deleting last current block must select its previous neighbor",
  );
  await choices(page, "aaaaaa", "single");
  await choices(peer, "aaaaaa", "stacked");
  await moveMenu(page, "aaaaaa", "top");
  await waitForValue(
    () => ids(peer),
    ["aaaaaa", "dddddd"],
    "second shared reorder did not arrive",
  );
  await removeBlock(page, "aaaaaa");
  await waitForValue(
    () => current(peer),
    "dddddd",
    "deleting current block must prefer its next neighbor",
  );
  await choices(page, "dddddd", "single");
  await choices(peer, "dddddd", "stacked");
  assert.deepEqual(
    (await manifest(id)).blocks.map((block) => block.id),
    ["dddddd"],
  );
  console.log(
    "PASS integrated two browser contexts with independent storage: reorder/name/language/delete shared; different presentation/current choices stay local; current deletion selects documented next/previous neighbor",
  );
  await second.close();
  await context.close();
}

async function assertEmpty(page) {
  await page.locator("[data-empty-page]").waitFor();
  assert.deepEqual(await ids(page), []);
  assert.equal(await current(page), null);
  assert.equal(await page.locator("[data-block-panel]").count(), 0);
  assert.equal(await page.locator("[data-manifest-unusable]").count(), 0);
  assert.equal(
    await page.locator("[data-sidebar-add-block]").isEnabled(),
    true,
  );
}

async function emptyAndReturn() {
  const id = await seedPage("empty");
  const context = await newContext();
  let page = await openPage(context, id);
  for (const block of blocks.slice(0, 3)) {
    assert.equal(await current(page), block.id);
    await removeBlock(page, block.id);
  }
  await assertEmpty(page);
  await waitForValue(
    async () => (await manifest(id)).blocks,
    [],
    "empty manifest not synchronized",
  );
  await page.reload();
  await ready(page, 0);
  await assertEmpty(page);
  await page.close();
  page = await openPage(context, id, 0);
  await assertEmpty(page);
  const second = await newContext();
  assert.deepEqual((await second.storageState()).origins, []);
  const peer = await openPage(second, id, 0);
  await assertEmpty(peer);
  await assertEmpty(page);
  await peer.locator("[data-sidebar-add-block]").click();
  await ready(peer, 1);
  const created = await current(peer);
  assert.ok(created && !blocks.some((block) => block.id === created));
  await typeSuffix(peer, created, "first block after empty");
  await ready(page, 1);
  await textIs(peer, created, "first block after empty");
  await textIs(page, created, "first block after empty");
  await choices(peer, created, "single");
  await waitForValue(
    () => fetchText(blockDoc(id, created)),
    "first block after empty",
    "new first block is not editable and synchronized",
  );
  console.log(
    "PASS integrated empty/return: delete each current block to zero, reload, close/reopen and second browser context with independent storage stay empty; sidebar-created first block becomes current, editable and shared",
  );
  await second.close();
  await context.close();
}

async function touchMove(cdp, from, to) {
  for (let step = 1; step <= 16; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * step) / 16,
          y: from.y + ((to.y - from.y) * step) / 16,
          id: 1,
        },
      ],
    });
  }
}

async function touchStart(page, cdp, id) {
  const handle = page.locator(`[data-sidebar-drag-handle="${id}"]`);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  assert.ok(box);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...point, id: 1 }],
  });
  await page.locator("[data-sidebar-drop-indicator]").waitFor();
  return point;
}

async function narrowTouch() {
  const entries = Array.from({ length: 18 }, (_, index) => ({
    ...blocks[0],
    id: `b${String(index).padStart(5, "0")}`,
    title: `Block ${index + 1}`,
  }));
  const order = entries.map((block) => block.id);
  const id = await seedPage("touch", entries);
  const context = await newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await openPage(context, id, entries.length);
  assert.equal(await page.evaluate(() => window.innerWidth), 390);
  assert.ok(await page.evaluate(() => navigator.maxTouchPoints > 0));
  assert.equal(
    await page.locator('nav[aria-label="Blocks"]').count(),
    0,
    "phone sidebar should start collapsed below 480px",
  );
  await page.getByLabel("Toggle sidebar", { exact: true }).tap();
  await page.locator('nav[aria-label="Blocks"]').waitFor();
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await row(page, "b00001").tap();
  await waitForValue(
    () => current(page),
    "b00001",
    "phone sidebar tap did not navigate",
  );
  await page.locator('[data-sidebar-block-menu="b00001"]').tap();
  await page.locator('[data-sidebar-move="b00001:top"]').tap();
  await waitForValue(
    () => ids(page),
    ["b00001", "b00000", ...order.slice(2)],
    "phone reorder menu did not move block",
  );
  await page.evaluate(() => {
    window.integratedTouchEvents = [];
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target.closest("[data-sidebar-drag-handle]")) {
          window.integratedTouchEvents.push({
            type: event.pointerType,
            trusted: event.isTrusted,
          });
        }
      },
      true,
    );
  });
  const cdp = await context.newCDPSession(page);
  const from = await touchStart(page, cdp, "b00000");
  const target = await page.locator('[data-block-row="b00001"]').boundingBox();
  assert.ok(target);
  await touchMove(cdp, from, {
    x: target.x + target.width / 2,
    y: target.y + 2,
  });
  await page
    .locator('[data-sidebar-drop-indicator][data-insert-before="b00001"]')
    .waitFor();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await waitForValue(
    () => ids(page),
    order,
    "phone touch handle drag did not restore order",
  );
  await page
    .locator("[data-sidebar-drop-indicator]")
    .waitFor({ state: "hidden" });
  const edgeStart = await touchStart(page, cdp, "b00000");
  const scroller = await page
    .locator('nav[aria-label="Blocks"]')
    .evaluate((nav) => {
      let node = nav;
      while (node) {
        if (
          ["auto", "scroll"].includes(getComputedStyle(node).overflowY) &&
          node.scrollHeight > node.clientHeight + 1
        ) {
          window.integratedScroller = node;
          const rect = node.getBoundingClientRect();
          return {
            top: node.scrollTop,
            x: rect.x + rect.width / 2,
            y: Math.min(rect.bottom, innerHeight) - 4,
          };
        }
        node = node.parentElement;
      }
      throw new Error("phone sidebar has no natural scroll container");
    });
  await touchMove(cdp, edgeStart, scroller);
  await page.waitForFunction(
    (before) => window.integratedScroller.scrollTop > before + 24,
    scroller.top,
  );
  const scrolled = await page.evaluate(
    () => window.integratedScroller.scrollTop,
  );
  assert.ok(
    scrolled > scroller.top + 24,
    `touch edge auto-scroll did not advance: ${scroller.top} -> ${scrolled}`,
  );
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page
    .locator("[data-sidebar-drop-indicator]")
    .waitFor({ state: "hidden" });
  const finalOrder = await ids(page);
  assert.ok(
    finalOrder.indexOf("b00000") > 1,
    `edge drag did not move beyond adjacent row: ${finalOrder}`,
  );
  assert.deepEqual([...finalOrder].sort(), [...order].sort());
  await waitForValue(
    async () => (await manifest(id)).blocks.map((block) => block.id),
    finalOrder,
    "phone drag order did not synchronize",
  );
  assert.deepEqual(await page.evaluate(() => window.integratedTouchEvents), [
    { type: "touch", trusted: true },
    { type: "touch", trusted: true },
  ]);
  await choices(page, "b00001", "single");
  console.log(
    `PASS integrated narrow/touch EMULATION ONLY (Chromium 390x844, hasTouch, CDP touch events; NOT a real-device result): sidebar navigation, reorder menu, pointerType=touch handle drag and natural edge auto-scroll ${scroller.top}->${scrolled}`,
  );
  await cdp.detach();
  await context.close();
}

try {
  for (const scenario of [
    heightMigration,
    sidebarChain,
    foldedHeadings,
    typingSwitch,
    sharedChanges,
    emptyAndReturn,
    narrowTouch,
  ]) {
    try {
      await scenario();
    } catch (error) {
      console.error(`FAIL integrated ${scenario.name}`);
      throw error;
    }
  }
} finally {
  await browser.close();
}
