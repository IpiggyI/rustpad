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
const SNAPSHOT_PREFIX = "block-workspace:snapshot:";

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

async function fetchManifestText(pageId) {
  const response = await fetch(
    new URL(`api/text/page:${pageId}:manifest`, base),
  );
  return response.text();
}

async function fetchManifest(pageId) {
  const text = await fetchManifestText(pageId);
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

async function seedDocument(pageId, text) {
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

async function seedManifest(pageId, manifest) {
  await seedDocument(pageId, JSON.stringify(manifest));
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
  if (blockCount === 0) {
    await page.locator("[data-empty-page]").waitFor();
  } else {
    const label = blockCount === 1 ? "(1 block)" : `(${blockCount} blocks)`;
    await page.getByText(label, { exact: true }).waitFor();
  }
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

async function waitForEmptyPage(page) {
  await page.locator("[data-empty-page]").waitFor();
  await page.locator("[data-sidebar-add-block]:not([disabled])").waitFor();
  assert.deepEqual(await sidebarIds(page), []);
  assert.equal(await currentBlockId(page), null);
  assert.equal(await page.locator("[data-block-panel]").count(), 0);
}

async function waitUntilEmptyOrUnusable(page) {
  // Both outcomes hide "Loading workspace..."; wait until one of them is on screen
  // so the empty-vs-damaged asserts run instead of timing out on [data-empty-page].
  await page.waitForFunction(() => {
    return Boolean(
      document.querySelector("[data-empty-page]") ||
        document.querySelector("[data-manifest-unusable]"),
    );
  });
}

async function clickSidebarSelect(page, blockId) {
  await page
    .locator(`nav[aria-label="Blocks"] [data-block-id="${blockId}"]`)
    .click();
  await waitForCurrent(page, blockId);
}

function deleteDialog(page) {
  return page.locator("[data-delete-block-dialog]");
}

async function openDelete(page, blockId, from) {
  if (from === "sidebar") {
    await page.locator(`[data-sidebar-remove-block="${blockId}"]`).click();
  } else {
    await page
      .locator(`[data-block-panel="${blockId}"]`)
      .getByLabel("Remove block")
      .click();
  }
  await deleteDialog(page).waitFor();
}

async function confirmDelete(page) {
  await page.locator("[data-confirm-delete-block]").click();
  await deleteDialog(page).waitFor({ state: "hidden" });
}

async function cancelDelete(page) {
  await page.locator("[data-cancel-delete-block]").click();
  await deleteDialog(page).waitFor({ state: "hidden" });
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

async function editorExists(page, blockId) {
  return page.evaluate((id) => {
    const editors = window.monaco?.editor.getEditors() ?? [];
    return editors.some((editor) =>
      editor.getModel()?.uri.toString().includes(`/${id}`),
    );
  }, blockId);
}

try {
  const pageId = `delblk${Date.now()}`;
  await seedManifest(pageId, {
    version: 1,
    title: "delete-block",
    compactHeights: true,
    blocks: [alpha, beta, gamma],
  });
  await waitForManifest(
    pageId,
    (manifest) => manifest.blocks?.length === 3,
    "server never received the delete-block seed",
  );

  const first = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const page = await openWorkspace(first, pageId, 3);
  await waitForCurrent(page, "aaaaaa");

  const currentBeforeCancel = await currentBlockId(page);
  await openDelete(page, "bbbbbb", "header");
  assert.equal((await deleteDialog(page).innerText()).includes("Beta"), true);
  await cancelDelete(page);
  assert.deepEqual(await sidebarIds(page), ["aaaaaa", "bbbbbb", "cccccc"]);
  assert.equal(await currentBlockId(page), currentBeforeCancel);
  await waitForManifest(
    pageId,
    (manifest) =>
      manifest.blocks?.length === 3 && manifest.blocks[1]?.id === "bbbbbb",
    "cancel from the header deleted a block",
  );
  console.log("PASS cancel header: prompt names the block and deletes nothing");

  await openDelete(page, "cccccc", "sidebar");
  assert.equal((await deleteDialog(page).innerText()).includes("Gamma"), true);
  await cancelDelete(page);
  assert.deepEqual(await sidebarIds(page), ["aaaaaa", "bbbbbb", "cccccc"]);
  assert.equal(await currentBlockId(page), currentBeforeCancel);
  console.log(
    "PASS cancel sidebar: prompt names the block and does not change current",
  );

  await waitForCurrent(page, "aaaaaa");
  await openDelete(page, "aaaaaa", "header");
  await confirmDelete(page);
  await waitForBlockCount(page, 2);
  await waitForCurrent(page, "bbbbbb");
  assert.deepEqual(await sidebarIds(page), ["bbbbbb", "cccccc"]);
  assert.equal(await page.locator('[data-block-panel="aaaaaa"]').count(), 0);
  await waitForManifest(
    pageId,
    (manifest) =>
      manifest.blocks?.length === 2 &&
      manifest.blocks.every((block) => block.id !== "aaaaaa"),
    "deleting the current block did not remove it",
  );
  console.log("PASS delete current: following block becomes current");
  await first.close();

  const middleId = `delmid${Date.now()}`;
  await seedManifest(middleId, {
    version: 1,
    title: "delete-middle",
    compactHeights: true,
    blocks: [alpha, beta, gamma],
  });
  await waitForManifest(
    middleId,
    (manifest) => manifest.blocks?.length === 3,
    "server never received the delete-middle seed",
  );
  const middleContext = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const middlePage = await openWorkspace(middleContext, middleId, 3);
  await waitForCurrent(middlePage, "aaaaaa");
  await openDelete(middlePage, "bbbbbb", "sidebar");
  await confirmDelete(middlePage);
  await waitForBlockCount(middlePage, 2);
  await waitForCurrent(middlePage, "aaaaaa");
  assert.deepEqual(await sidebarIds(middlePage), ["aaaaaa", "cccccc"]);
  await waitForManifest(
    middleId,
    (manifest) =>
      manifest.blocks?.length === 2 &&
      manifest.blocks[0]?.id === "aaaaaa" &&
      manifest.blocks[1]?.id === "cccccc",
    "deleting the middle block did not remove only that block",
  );
  console.log("PASS delete middle: current block is unchanged");
  await middleContext.close();

  const endId = `delend${Date.now()}`;
  await seedManifest(endId, {
    version: 1,
    title: "delete-end",
    compactHeights: true,
    blocks: [alpha, beta, gamma],
  });
  await waitForManifest(
    endId,
    (manifest) => manifest.blocks?.length === 3,
    "server never received the delete-end seed",
  );
  const endContext = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const endPage = await openWorkspace(endContext, endId, 3);
  await waitForCurrent(endPage, "aaaaaa");
  await openDelete(endPage, "cccccc", "header");
  await confirmDelete(endPage);
  await waitForBlockCount(endPage, 2);
  await waitForCurrent(endPage, "aaaaaa");
  assert.deepEqual(await sidebarIds(endPage), ["aaaaaa", "bbbbbb"]);
  await waitForManifest(
    endId,
    (manifest) =>
      manifest.blocks?.length === 2 &&
      manifest.blocks.every((block) => block.id !== "cccccc"),
    "deleting the last block in order did not remove it",
  );
  console.log("PASS delete end: current block is unchanged");
  await endContext.close();

  const onlyId = `delonly${Date.now()}`;
  await seedManifest(onlyId, {
    version: 1,
    title: "delete-only",
    compactHeights: true,
    blocks: [alpha],
  });
  await waitForManifest(
    onlyId,
    (manifest) => manifest.blocks?.length === 1,
    "server never received the delete-only seed",
  );
  const onlyContext = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const onlyPage = await openWorkspace(onlyContext, onlyId, 1);
  await waitForCurrent(onlyPage, "aaaaaa");
  await onlyPage.evaluate(
    ({ key, snapshotKey, zombie }) => {
      localStorage.setItem(key, "aaaaaa");
      localStorage.setItem(snapshotKey, JSON.stringify(zombie));
    },
    {
      key: currentKey(onlyId),
      snapshotKey: `${SNAPSHOT_PREFIX}${onlyId}`,
      zombie: {
        version: 1,
        compactHeights: true,
        blocks: [
          {
            id: "zzzzzz",
            title: "Zombie",
            language: "plaintext",
            content: "resurrected",
          },
        ],
      },
    },
  );
  await openDelete(onlyPage, "aaaaaa", "header");
  await confirmDelete(onlyPage);
  await waitForEmptyPage(onlyPage);
  await waitForManifest(
    onlyId,
    (manifest) =>
      Array.isArray(manifest.blocks) &&
      manifest.blocks.length === 0 &&
      manifest.compactHeights === true,
    "deleting the only block did not leave an empty manifest",
  );
  console.log("PASS delete only: page is empty with a usable add entry");

  await onlyPage.evaluate(
    ({ snapshotKey, zombie }) => {
      localStorage.setItem(snapshotKey, JSON.stringify(zombie));
    },
    {
      snapshotKey: `${SNAPSHOT_PREFIX}${onlyId}`,
      zombie: {
        version: 1,
        compactHeights: true,
        blocks: [
          {
            id: "zzzzzz",
            title: "Zombie",
            language: "plaintext",
            content: "resurrected",
          },
        ],
      },
    },
  );
  await onlyPage.reload();
  await onlyPage.evaluate(() =>
    document.querySelector("vite-error-overlay")?.remove(),
  );
  await onlyPage.getByText("You are connected!", { exact: true }).waitFor();
  await waitUntilEmptyOrUnusable(onlyPage);
  assert.equal(await onlyPage.locator("[data-manifest-unusable]").count(), 0);
  assert.equal(
    await onlyPage.getByText("The block list could not be read.").count(),
    0,
  );
  assert.equal(
    await onlyPage.locator("[data-sidebar-add-block]").isDisabled(),
    false,
  );
  await waitForEmptyPage(onlyPage);
  await waitForManifest(
    onlyId,
    (manifest) =>
      Array.isArray(manifest.blocks) && manifest.blocks.length === 0,
    "reload reseeding an empty page",
  );
  const emptiedText = await fetchManifestText(onlyId);
  const emptiedDecision = await onlyPage.evaluate(async (text) => {
    const { parseManifest } = await import("/src/manifestOps.ts");
    const { decideManifestInit } = await import("/src/manifestInit.ts");
    return decideManifestInit({
      firstFullReplayCompleted: true,
      authoritativeRawText: text,
      parsed: parseManifest(text),
      snapshot: {
        version: 1,
        blocks: [{ id: "zzzzzz", title: "Zombie", language: "plaintext" }],
      },
      fallback: {
        version: 1,
        blocks: [{ id: "ffffff", title: "Fallback", language: "plaintext" }],
      },
    });
  }, emptiedText);
  assert.equal(emptiedDecision.action, "adopt");
  assert.deepEqual(emptiedDecision.manifest.blocks, []);
  console.log("PASS reload empty: stale snapshot does not resurrect blocks");

  const second = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const peerEmpty = await openWorkspace(second, onlyId, 0);
  await waitForEmptyPage(peerEmpty);
  console.log("PASS second context: empty page opens empty");

  await onlyPage.locator("[data-sidebar-add-block]").click();
  await waitForBlockCount(onlyPage, 1);
  const createdId = await currentBlockId(onlyPage);
  assert.ok(createdId);
  await waitForCurrent(onlyPage, createdId);
  await typeInBlock(onlyPage, createdId, "from-empty");
  await waitForEditorValue(onlyPage, createdId, "from-empty");
  console.log("PASS add from empty: new block is current and editable");
  await second.close();
  await onlyContext.close();

  const namesId = `delnames${Date.now()}`;
  await seedManifest(namesId, {
    version: 1,
    title: "delete-names",
    compactHeights: true,
    blocks: [
      { ...alpha, title: "Notes" },
      { ...beta, title: "Notes" },
      { ...gamma, title: "Notes" },
    ],
  });
  await waitForManifest(
    namesId,
    (manifest) => manifest.blocks?.length === 3,
    "server never received the same-name seed",
  );
  const namesContext = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const namesPage = await openWorkspace(namesContext, namesId, 3);
  await waitForCurrent(namesPage, "aaaaaa");
  await openDelete(namesPage, "bbbbbb", "sidebar");
  assert.equal(
    (await deleteDialog(namesPage).innerText()).includes("Notes"),
    true,
  );
  await confirmDelete(namesPage);
  await waitForBlockCount(namesPage, 2);
  await waitForCurrent(namesPage, "aaaaaa");
  assert.deepEqual(await sidebarIds(namesPage), ["aaaaaa", "cccccc"]);
  await waitForManifest(
    namesId,
    (manifest) =>
      manifest.blocks?.length === 2 &&
      manifest.blocks[0]?.id === "aaaaaa" &&
      manifest.blocks[1]?.id === "cccccc",
    "deleting the second same-named block removed the wrong target",
  );
  console.log("PASS same name: deleting the second removes the second");
  await namesContext.close();

  const remoteId = `delremote${Date.now()}`;
  await seedManifest(remoteId, {
    version: 1,
    title: "delete-remote",
    compactHeights: true,
    blocks: [alpha, beta, gamma],
  });
  await waitForManifest(
    remoteId,
    (manifest) => manifest.blocks?.length === 3,
    "server never received the remote-delete seed",
  );
  const localContext = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const localPage = await openWorkspace(localContext, remoteId, 3);
  const remoteContext = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const remotePage = await openWorkspace(remoteContext, remoteId, 3);
  await clickSidebarSelect(localPage, "bbbbbb");
  await waitForCurrent(remotePage, "aaaaaa");
  await openDelete(remotePage, "bbbbbb", "header");
  await confirmDelete(remotePage);
  await waitForBlockCount(localPage, 2);
  await waitForCurrent(localPage, "cccccc");
  assert.equal(await deleteDialog(localPage).isVisible(), false);
  assert.equal(
    await localPage.locator('[data-block-panel="bbbbbb"]').count(),
    0,
  );
  assert.equal(await editorExists(localPage, "bbbbbb"), false);
  console.log(
    "PASS remote delete: no local prompt, current follows, editor is gone",
  );
  await remoteContext.close();
  await localContext.close();

  const damagedId = `deldmg${Date.now()}`;
  const damagedText = "{not json";
  await seedDocument(damagedId, damagedText);
  const damagedContext = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const damagedPage = await damagedContext.newPage();
  await damagedPage.addInitScript((id) => {
    localStorage.setItem(`blockPresentation:page:${id}`, "stacked");
  }, damagedId);
  await damagedPage.goto(`${base}/#page:${damagedId}`);
  await damagedPage.evaluate(() =>
    document.querySelector("vite-error-overlay")?.remove(),
  );
  await damagedPage.getByText("You are connected!", { exact: true }).waitFor();
  await damagedPage.locator("[data-manifest-unusable]").waitFor();
  assert.equal(
    await damagedPage.getByText("The block list could not be read.").count(),
    2,
  );
  assert.equal(await damagedPage.getByText("Loading workspace...").count(), 0);
  assert.equal(await damagedPage.locator("[data-empty-page]").count(), 0);
  assert.equal(
    await damagedPage.getByText("This page has no blocks.").count(),
    0,
  );
  assert.equal(
    await damagedPage.locator("[data-sidebar-add-block]").isDisabled(),
    true,
  );
  assert.equal(await fetchManifestText(damagedId), damagedText);
  console.log("PASS unusable: damaged list is named and is not overwritten");
  await damagedContext.close();
} finally {
  await browser.close();
}
