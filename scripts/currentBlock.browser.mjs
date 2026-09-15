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

const alpha = {
  id: "aaaaaa",
  title: "Alpha",
  language: "plaintext",
  height: 520,
};
const beta = {
  id: "bbbbbb",
  title: "Beta",
  language: "plaintext",
  height: 520,
};
const gamma = {
  id: "cccccc",
  title: "Gamma",
  language: "plaintext",
  height: 520,
  collapsed: true,
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

async function openPage(context, pageId) {
  const page = await context.newPage();
  await page.addInitScript((id) => {
    localStorage.setItem(`blockPresentation:page:${id}`, "stacked");
  }, pageId);
  await page.goto(`${base}/#page:${pageId}`);
  await page.evaluate(() =>
    document.querySelector("vite-error-overlay")?.remove(),
  );
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.getByText("(3 blocks)", { exact: true }).waitFor();
  await page
    .locator('nav[aria-label="Blocks"] [data-block-id]')
    .nth(2)
    .waitFor();
  return page;
}

async function sidebarIds(page) {
  return page
    .locator('nav[aria-label="Blocks"] [data-block-id]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-block-id")));
}

async function currentBlockId(page) {
  return page
    .locator('nav[aria-label="Blocks"] [aria-current="true"]')
    .getAttribute("data-block-id");
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

async function clickSidebar(page, blockId) {
  await page
    .locator(`nav[aria-label="Blocks"] [data-block-id="${blockId}"]`)
    .click();
  await waitForCurrent(page, blockId);
}

async function panelVisibility(page, blockId) {
  return page.evaluate((id) => {
    const panel = document.querySelector(`[data-block-panel="${id}"]`);
    const scroller = document.querySelector("[data-block-scroll]");
    if (!panel || !scroller) return null;
    const p = panel.getBoundingClientRect();
    const c = scroller.getBoundingClientRect();
    const overlap = Math.min(p.bottom, c.bottom) - Math.max(p.top, c.top);
    return {
      overlap,
      inView: overlap > 8,
      panelTop: p.top,
      scrollerTop: c.top,
      scrollerBottom: c.bottom,
    };
  }, blockId);
}

async function waitForPanelInView(page, blockId) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 8000) {
    last = await panelVisibility(page, blockId);
    if (last?.inView) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `block ${blockId} did not scroll into view; last=${JSON.stringify(last)}`,
  );
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

try {
  const pageId = `curblk${Date.now()}`;
  await seedManifest(pageId, {
    version: 1,
    title: "current-block",
    compactHeights: true,
    blocks: [alpha, beta, gamma],
  });
  await waitForManifest(
    pageId,
    (manifest) =>
      manifest.blocks?.length === 3 &&
      manifest.blocks[2]?.collapsed === true &&
      manifest.compactHeights === true,
    "server never received the current-block seed",
  );

  const first = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const page = await openPage(first, pageId);
  assert.deepEqual(await sidebarIds(page), ["aaaaaa", "bbbbbb", "cccccc"]);
  await waitForCurrent(page, "aaaaaa");
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), currentKey(pageId)),
    "aaaaaa",
  );
  console.log("PASS open: sidebar lists every block and first is current");

  const beforeBeta = await panelVisibility(page, "bbbbbb");
  assert.ok(beforeBeta, "expected beta panel");
  if (beforeBeta.inView) {
    await page.evaluate(() => {
      const scroller = document.querySelector("[data-block-scroll]");
      if (scroller) scroller.scrollTop = 0;
    });
  }
  await clickSidebar(page, "bbbbbb");
  await waitForPanelInView(page, "bbbbbb");
  assert.equal(await currentBlockId(page), "bbbbbb");
  console.log(
    "PASS click: sidebar entry scrolls the block into view and marks it",
  );

  await clickSidebar(page, "cccccc");
  await waitForPanelInView(page, "cccccc");
  assert.equal(
    await page
      .locator('[data-block-panel="cccccc"] [title="Drag to resize"]')
      .count(),
    0,
  );
  const afterCollapsedClick = await fetchManifest(pageId);
  const gammaAfter = afterCollapsedClick.blocks.find(
    (block) => block.id === "cccccc",
  );
  assert.equal(gammaAfter?.collapsed, true);
  console.log(
    "PASS click collapsed: header in view, collapsed still true in the manifest",
  );

  await page.locator('[data-block-panel="aaaaaa"] .monaco-editor').click();
  await page.keyboard.type("keep-a");
  await page.waitForFunction((value) => {
    const editors = window.monaco?.editor.getEditors() ?? [];
    const ed = editors.find((editor) =>
      editor.getModel()?.uri.toString().includes("/aaaaaa"),
    );
    return ed?.getValue()?.includes(value) === true;
  }, "keep-a");
  await clickSidebar(page, "bbbbbb");
  assert.equal((await editorValue(page, "aaaaaa"))?.includes("keep-a"), true);
  await typeInBlock(page, "bbbbbb", "from-b");
  await waitForCurrent(page, "bbbbbb");
  assert.equal((await editorValue(page, "aaaaaa"))?.includes("keep-a"), true);
  console.log(
    "PASS edit: typing in a block selects it and does not clear the other",
  );

  await page.evaluate(() => {
    const scroller = document.querySelector("[data-block-scroll]");
    if (!scroller) return;
    scroller.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const scroller = document.querySelector("[data-block-scroll]");
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForTimeout(300);
  assert.equal(await currentBlockId(page), "bbbbbb");
  console.log(
    "PASS scroll: ordinary scrolling does not change the current block",
  );

  await page.reload();
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.getByText("(3 blocks)", { exact: true }).waitFor();
  await waitForCurrent(page, "bbbbbb");
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), currentKey(pageId)),
    "bbbbbb",
  );
  console.log("PASS reload: current block survives");

  const second = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const peer = await openPage(second, pageId);
  assert.deepEqual(await sidebarIds(peer), ["aaaaaa", "bbbbbb", "cccccc"]);
  await waitForCurrent(peer, "aaaaaa");
  await waitForCurrent(page, "bbbbbb");
  assert.equal(
    await peer.evaluate((key) => localStorage.getItem(key), currentKey(pageId)),
    "aaaaaa",
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), currentKey(pageId)),
    "bbbbbb",
  );
  const shared = await fetchManifest(pageId);
  assert.equal("currentBlock" in shared, false);
  assert.equal(shared.currentBlockId, undefined);
  assert.deepEqual(
    shared.blocks.map((block) => block.id),
    ["aaaaaa", "bbbbbb", "cccccc"],
  );
  await clickSidebar(page, "cccccc");
  await waitForCurrent(peer, "aaaaaa");
  console.log(
    "PASS two contexts: independent current blocks, shared block list, selection not in the manifest",
  );
  await second.close();

  await clickSidebar(page, "bbbbbb");
  await page
    .locator('[data-block-panel="bbbbbb"]')
    .getByLabel("Remove block")
    .click();
  await page.getByText("(2 blocks)", { exact: true }).waitFor();
  await waitForCurrent(page, "cccccc");
  await waitForManifest(
    pageId,
    (manifest) =>
      manifest.blocks?.length === 2 &&
      manifest.blocks.every((block) => block.id !== "bbbbbb"),
    "deleted block remained in the manifest",
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), currentKey(pageId)),
    "cccccc",
  );
  console.log("PASS delete current: following block becomes current");
  await first.close();
} finally {
  await browser.close();
}
