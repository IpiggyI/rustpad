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
import { readFileSync } from "node:fs";

const base = process.env.RUSTPAD_URL || "http://127.0.0.1:5173";
const languages = JSON.parse(
  readFileSync(new URL("../src/languages.json", import.meta.url), "utf8"),
);

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

const alpha = {
  id: "aaaaaa",
  title: "Alpha",
  language: "plaintext",
  height: 200,
};
const beta = {
  id: "bbbbbb",
  title: "Beta",
  language: "plaintext",
  height: 200,
};
const gamma = {
  id: "cccccc",
  title: "Gamma",
  language: "plaintext",
  height: 200,
};

function currentKey(pageId) {
  return `currentBlock:page:${pageId}`;
}

function wsUrl(docId) {
  const url = new URL(`api/socket/${docId}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

async function fetchManifest(pageId) {
  const response = await fetch(
    new URL(`api/text/page:${pageId}:manifest`, base),
  );
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function waitForManifest(pageId, predicate, message) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 10000) {
    last = await fetchManifest(pageId);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${message}; last=${JSON.stringify(last)}`);
}

async function seedManifest(pageId, manifest) {
  const text = JSON.stringify(manifest);
  const ws = new WebSocket(wsUrl(`page:${pageId}:manifest`));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("seed timeout")), 8000);
    let sent = false;
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.History === undefined) return;
      if (!sent) {
        assert.deepEqual(msg.History.operations, []);
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
    ws.addEventListener("close", () => {
      if (!sent) {
        clearTimeout(timer);
        reject(new Error("seed socket closed before edit"));
      }
    });
  });
  ws.close();
}

async function openWorkspace(context, pageId, blockCount) {
  const page = await context.newPage();
  await page.addInitScript((id) => {
    localStorage.setItem(`blockPresentation:page:${id}`, "stacked");
  }, pageId);
  await page.goto(`${base}/#page:${pageId}`);
  await page.evaluate(() =>
    document.querySelector("vite-error-overlay")?.remove(),
  );
  await page.getByText("You are connected!", { exact: true }).waitFor();
  const label = blockCount === 1 ? "(1 block)" : `(${blockCount} blocks)`;
  await page.getByText(label, { exact: true }).waitFor();
  return page;
}

async function sidebarIds(page) {
  return page
    .locator('nav[aria-label="Blocks"] [data-block-id]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-block-id")));
}

async function currentBlockId(page) {
  const current = page.locator(
    'nav[aria-label="Blocks"] [aria-current="true"]',
  );
  if ((await current.count()) === 0) return null;
  return current.getAttribute("data-block-id");
}

async function waitForCurrent(page, blockId) {
  await page.waitForFunction((want) => {
    const current = document.querySelector(
      'nav[aria-label="Blocks"] [aria-current="true"]',
    );
    return current?.getAttribute("data-block-id") === want;
  }, blockId);
  assert.equal(await currentBlockId(page), blockId);
}

async function waitForBlockCount(page, count) {
  const label = count === 1 ? "(1 block)" : `(${count} blocks)`;
  await page.getByText(label, { exact: true }).waitFor();
}

async function clickSidebarSelect(page, blockId) {
  await page
    .locator(`nav[aria-label="Blocks"] [data-block-id="${blockId}"]`)
    .click();
  await waitForCurrent(page, blockId);
}

async function optionValues(locator) {
  return locator
    .locator("option")
    .evaluateAll((els) => els.map((el) => el.value));
}

async function editorValue(page, blockId) {
  return page.evaluate((id) => {
    const editors = window.monaco?.editor.getEditors() ?? [];
    const ed = editors.find((editor) =>
      editor.getModel()?.uri.toString().includes(`/${id}`),
    );
    return ed?.getValue() ?? null;
  }, blockId);
}

async function typeInBlock(page, blockId, text) {
  await page.waitForFunction((id) => {
    const editors = window.monaco?.editor.getEditors() ?? [];
    return editors.some((editor) =>
      editor.getModel()?.uri.toString().includes(`/${id}`),
    );
  }, blockId);
  await page.locator(`[data-block-panel="${blockId}"] .monaco-editor`).click();
  await page.keyboard.type(text);
}

async function waitForEditorValue(page, blockId, snippet) {
  await page.waitForFunction(
    ({ id, value }) => {
      const editors = window.monaco?.editor.getEditors() ?? [];
      const ed = editors.find((editor) =>
        editor.getModel()?.uri.toString().includes(`/${id}`),
      );
      return ed?.getValue()?.includes(value) === true;
    },
    { id: blockId, value: snippet },
  );
}

try {
  const pageId = `sideblk${Date.now()}`;
  await seedManifest(pageId, {
    version: 1,
    title: "sidebar-blocks",
    compactHeights: true,
    blocks: [alpha, beta, gamma],
  });
  await waitForManifest(
    pageId,
    (manifest) => manifest.blocks?.length === 3,
    "server never received the sidebar-blocks seed",
  );

  const first = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const page = await openWorkspace(first, pageId, 3);
  const second = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const peer = await openWorkspace(second, pageId, 3);
  await waitForCurrent(page, "aaaaaa");
  await waitForCurrent(peer, "aaaaaa");

  await typeInBlock(peer, "aaaaaa", "peer-keep");
  await waitForEditorValue(peer, "aaaaaa", "peer-keep");

  await clickSidebarSelect(page, "bbbbbb");
  await waitForCurrent(peer, "aaaaaa");

  const sidebarLangs = await optionValues(
    page.locator('[data-block-language="bbbbbb"]'),
  );
  const headerLangs = await optionValues(
    page.locator('[data-block-panel="bbbbbb"] select'),
  );
  assert.deepEqual(sidebarLangs, languages);
  assert.deepEqual(headerLangs, languages);

  await page.locator("[data-sidebar-add-block]").click();
  await waitForBlockCount(page, 4);
  await waitForBlockCount(peer, 4);
  const createdId = await currentBlockId(page);
  assert.ok(createdId);
  assert.notEqual(createdId, "bbbbbb");
  assert.deepEqual(await sidebarIds(page), [
    "aaaaaa",
    "bbbbbb",
    createdId,
    "cccccc",
  ]);
  assert.deepEqual(await sidebarIds(peer), [
    "aaaaaa",
    "bbbbbb",
    createdId,
    "cccccc",
  ]);
  await page.waitForFunction((id) => {
    const el = document.activeElement;
    return (
      el instanceof HTMLInputElement &&
      el.getAttribute("data-block-name") === id
    );
  }, createdId);
  assert.equal(
    await page.locator(`[data-block-name="${createdId}"]`).inputValue(),
    "Untitled",
  );
  assert.equal(
    await page.locator(`[data-block-language="${createdId}"]`).inputValue(),
    "plaintext",
  );
  await waitForCurrent(peer, "aaaaaa");
  console.log(
    "PASS create: sidebar add inserts after the current block and focuses the name",
  );

  await page.locator(`[data-block-name="${createdId}"]`).fill("Notes");
  await page.waitForFunction((id) => {
    const header = document.querySelector(`[data-block-panel="${id}"] input`);
    const sidebar = document.querySelector(`[data-block-name="${id}"]`);
    return (
      header instanceof HTMLInputElement &&
      sidebar instanceof HTMLInputElement &&
      header.value === "Notes" &&
      sidebar.value === "Notes"
    );
  }, createdId);
  await typeInBlock(page, createdId, "hello-body");
  await waitForEditorValue(page, createdId, "hello-body");
  await waitForManifest(
    pageId,
    (manifest) =>
      manifest.blocks?.some(
        (block) => block.id === createdId && block.title === "Notes",
      ),
    "renamed block never reached the manifest",
  );
  console.log("PASS name-and-body: create, name, then type in the body");

  const currentBeforeNameClick = await currentBlockId(page);
  assert.equal(currentBeforeNameClick, createdId);
  await page.locator('[data-block-name="aaaaaa"]').click();
  assert.equal(await currentBlockId(page), createdId);
  await page.locator('[data-block-name="aaaaaa"]').fill("Notes");
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-block-name="aaaaaa"]');
    const header = document.querySelector('[data-block-panel="aaaaaa"] input');
    return (
      input instanceof HTMLInputElement &&
      header instanceof HTMLInputElement &&
      input.value === "Notes" &&
      header.value === "Notes"
    );
  });
  assert.equal(await currentBlockId(page), createdId);
  const idsAfterRename = await sidebarIds(page);
  assert.deepEqual(idsAfterRename, ["aaaaaa", "bbbbbb", createdId, "cccccc"]);
  assert.equal(
    await page.locator('[data-block-name="aaaaaa"]').inputValue(),
    "Notes",
  );
  assert.equal(
    await page.locator(`[data-block-name="${createdId}"]`).inputValue(),
    "Notes",
  );
  assert.notEqual("aaaaaa", createdId);
  console.log(
    "PASS rename: duplicate names stay distinct; name click does not change current",
  );

  await page
    .locator(`[data-block-language="${createdId}"]`)
    .selectOption("javascript");
  await page.waitForFunction((id) => {
    const sidebar = document.querySelector(`[data-block-language="${id}"]`);
    const header = document.querySelector(`[data-block-panel="${id}"] select`);
    return (
      sidebar instanceof HTMLSelectElement &&
      header instanceof HTMLSelectElement &&
      sidebar.value === "javascript" &&
      header.value === "javascript"
    );
  }, createdId);
  await peer.waitForFunction((id) => {
    const sidebar = document.querySelector(`[data-block-language="${id}"]`);
    const header = document.querySelector(`[data-block-panel="${id}"] select`);
    return (
      sidebar instanceof HTMLSelectElement &&
      header instanceof HTMLSelectElement &&
      sidebar.value === "javascript" &&
      header.value === "javascript"
    );
  }, createdId);
  await waitForCurrent(peer, "aaaaaa");
  assert.equal(
    (await editorValue(peer, "aaaaaa"))?.includes("peer-keep"),
    true,
  );
  assert.equal(
    (await editorValue(page, createdId))?.includes("hello-body"),
    true,
  );
  console.log(
    "PASS language: sidebar choice reaches the header, a second context, and does not move the peer",
  );

  const stackedAdds = page.locator(
    '[data-block-scroll] button:has-text("Add Block")',
  );
  await stackedAdds.first().click();
  await waitForBlockCount(page, 5);
  const afterPrepend = await sidebarIds(page);
  assert.equal(afterPrepend.length, 5);
  assert.equal(afterPrepend[1], "aaaaaa");
  assert.deepEqual(afterPrepend.slice(1), [
    "aaaaaa",
    "bbbbbb",
    createdId,
    "cccccc",
  ]);
  await waitForCurrent(page, createdId);
  await stackedAdds.last().click();
  await waitForBlockCount(page, 6);
  const afterAppend = await sidebarIds(page);
  assert.equal(afterAppend.length, 6);
  assert.deepEqual(afterAppend.slice(0, 5), afterPrepend);
  await waitForCurrent(page, createdId);
  await waitForCurrent(peer, "aaaaaa");
  console.log(
    "PASS stacked add: top prepends and bottom appends without taking the sidebar rule",
  );

  await second.close();
  await first.close();

  const emptyId = `sideempty${Date.now()}`;
  await seedManifest(emptyId, {
    version: 1,
    title: "sidebar-empty",
    compactHeights: true,
    blocks: [],
  });
  await waitForManifest(
    emptyId,
    (manifest) =>
      Array.isArray(manifest.blocks) && manifest.blocks.length === 0,
    "server never received the empty sidebar seed",
  );
  const emptyContext = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const emptyPage = await openWorkspace(emptyContext, emptyId, 0);
  assert.deepEqual(await sidebarIds(emptyPage), []);
  assert.equal(await currentBlockId(emptyPage), null);
  await emptyPage.locator("[data-sidebar-add-block]").click();
  await waitForBlockCount(emptyPage, 1);
  const emptyIds = await sidebarIds(emptyPage);
  assert.equal(emptyIds.length, 1);
  const firstId = emptyIds[0];
  assert.ok(firstId);
  await waitForCurrent(emptyPage, firstId);
  await emptyPage.waitForFunction((id) => {
    const el = document.activeElement;
    return (
      el instanceof HTMLInputElement &&
      el.getAttribute("data-block-name") === id
    );
  }, firstId);
  await emptyPage.locator(`[data-block-name="${firstId}"]`).fill("First");
  await typeInBlock(emptyPage, firstId, "empty-body");
  await waitForEditorValue(emptyPage, firstId, "empty-body");
  assert.equal(
    await emptyPage.evaluate(
      (key) => localStorage.getItem(key),
      currentKey(emptyId),
    ),
    firstId,
  );
  console.log(
    "PASS empty: sidebar add creates the first block, names it, and the body is editable",
  );
  await emptyContext.close();
} finally {
  await browser.close();
}
