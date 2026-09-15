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

const folds = [
  {
    startLineNumber: 1,
    endLineNumber: 4,
    isCollapsed: true,
    checksum: 42,
  },
];

const alpha = {
  id: "aaaaaa",
  title: "Alpha",
  language: "markdown",
  height: 240,
  collapsed: true,
  folds,
};
const beta = {
  id: "bbbbbb",
  title: "Beta",
  language: "python",
  height: 180,
  collapsed: false,
};
const gamma = {
  id: "cccccc",
  title: "Gamma",
  language: "rust",
  height: 200,
};

function wsUrl(docId) {
  const url = new URL(`api/socket/${docId}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

async function fetchText(docId) {
  const response = await fetch(new URL(`api/text/${docId}`, base));
  return response.text();
}

async function fetchManifest(pageId) {
  const text = await fetchText(`page:${pageId}:manifest`);
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

async function seedDocument(docId, text) {
  const ws = new WebSocket(wsUrl(docId));
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
  await seedDocument(`page:${pageId}:manifest`, JSON.stringify(manifest));
}

async function seedPage(pageId, blocks) {
  await seedManifest(pageId, {
    version: 1,
    title: "reorder-blocks",
    compactHeights: true,
    blocks,
  });
  await waitForManifest(
    pageId,
    (manifest) => manifest.blocks?.length === blocks.length,
    "server never received the reorder seed",
  );
}

function expectedFromInsert(beforeIds, movedId, insertBefore) {
  const others = beforeIds.filter((id) => id !== movedId);
  if (!insertBefore) return [...others, movedId];
  const index = others.indexOf(insertBefore);
  assert.notEqual(
    index,
    -1,
    `indicator ${insertBefore} missing from ${others}`,
  );
  return [...others.slice(0, index), movedId, ...others.slice(index)];
}

function fieldsById(blocks) {
  return Object.fromEntries(
    blocks.map((block) => [
      block.id,
      {
        title: block.title,
        language: block.language,
        height: block.height,
        collapsed: block.collapsed,
        folds: block.folds ?? null,
      },
    ]),
  );
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

async function newCountedContext() {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  await context.addInitScript(() => {
    window.__manifestEdits = 0;
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const str = typeof data === "string" ? data : "";
        if (this.url.includes(":manifest") && str.includes('"Edit"')) {
          window.__manifestEdits += 1;
        }
      } catch {
        // counting must not break the socket
      }
      return orig.apply(this, arguments);
    };
  });
  return context;
}

async function manifestEditCount(page) {
  return page.evaluate(() => window.__manifestEdits ?? 0);
}

async function sidebarIds(page) {
  return page
    .locator('nav[aria-label="Blocks"] [data-block-id]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-block-id")));
}

async function stackedIds(page) {
  return page
    .locator("[data-block-scroll] [data-block-panel]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-block-panel")));
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

async function waitForSidebarIds(page, ids) {
  await page.waitForFunction((want) => {
    const got = [
      ...document.querySelectorAll('nav[aria-label="Blocks"] [data-block-id]'),
    ].map((el) => el.getAttribute("data-block-id"));
    return got.join(",") === want.join(",");
  }, ids);
  assert.deepEqual(await sidebarIds(page), ids);
}

const sidebarMoveAttr = {
  "Move Up": "up",
  "Move Down": "down",
  "Move to Top": "top",
  "Move to Bottom": "bottom",
};

async function clickSidebarMove(page, blockId, name) {
  const direction = sidebarMoveAttr[name];
  assert.ok(direction, `unknown move ${name}`);
  const button = page.locator(`[data-sidebar-reorder-menu="${blockId}"]`);
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await page.locator(`[data-sidebar-move="${blockId}:${direction}"]`).click();
}

async function restoreAbc(page) {
  await clickSidebarMove(page, "aaaaaa", "Move to Top");
  const ids = await sidebarIds(page);
  if (ids[1] === "cccccc") {
    await clickSidebarMove(page, "bbbbbb", "Move Up");
  }
  await waitForSidebarIds(page, ["aaaaaa", "bbbbbb", "cccccc"]);
}

async function pointerDragHandle(
  page,
  movedId,
  targetId,
  { pointerType = "mouse", targetEdge = "start", release = "on-target" } = {},
) {
  const handle = page.locator(`[data-sidebar-drag-handle="${movedId}"]`);
  await handle.waitFor();
  const from = await handle.boundingBox();
  assert.ok(from);
  const target = page.locator(`[data-block-row="${targetId}"]`);
  const to = await target.boundingBox();
  assert.ok(to);
  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height / 2;
  const toX = to.x + to.width / 2;
  const toY = targetEdge === "end" ? to.y + to.height - 2 : to.y + 2;

  if (pointerType === "mouse") {
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 16 });
  } else {
    await page.evaluate(
      async ({ moved, startX, startY, endX, endY }) => {
        const el = document.querySelector(
          `[data-sidebar-drag-handle="${moved}"]`,
        );
        el.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: "touch",
            clientX: startX,
            clientY: startY,
            button: 0,
            buttons: 1,
          }),
        );
        const steps = 16;
        for (let i = 1; i <= steps; i++) {
          document.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              cancelable: true,
              composed: true,
              pointerId: 1,
              pointerType: "touch",
              clientX: startX + ((endX - startX) * i) / steps,
              clientY: startY + ((endY - startY) * i) / steps,
              button: 0,
              buttons: 1,
            }),
          );
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      },
      {
        moved: movedId,
        startX: fromX,
        startY: fromY,
        endX: toX,
        endY: toY,
      },
    );
  }

  const indicator = page.locator("[data-sidebar-drop-indicator]");
  await indicator.waitFor();
  const insertBefore = await indicator.getAttribute("data-insert-before");

  if (release === "escape") {
    await page.keyboard.press("Escape");
    await indicator.waitFor({ state: "detached" });
    return { insertBefore };
  }

  if (release === "outside") {
    const nav = await page.locator('nav[aria-label="Blocks"]').boundingBox();
    assert.ok(nav);
    const outsideX = nav.x + nav.width + 48;
    const outsideY = nav.y + 8;
    if (pointerType === "mouse") {
      await page.mouse.move(outsideX, outsideY, { steps: 8 });
      await page.mouse.up();
    } else {
      await page.evaluate(
        ({ x, y }) => {
          document.dispatchEvent(
            new PointerEvent("pointerup", {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: "touch",
              clientX: x,
              clientY: y,
              button: 0,
              buttons: 0,
            }),
          );
        },
        { x: outsideX, y: outsideY },
      );
    }
    await indicator.waitFor({ state: "detached" });
    return { insertBefore };
  }

  if (pointerType === "mouse") {
    await page.mouse.up();
  } else {
    await page.evaluate(
      ({ x, y }) => {
        document.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "touch",
            clientX: x,
            clientY: y,
            button: 0,
            buttons: 0,
          }),
        );
      },
      { x: toX, y: toY },
    );
  }
  await indicator.waitFor({ state: "detached" });
  return { insertBefore };
}

async function assertNoDragFrom(page, locator) {
  const before = await sidebarIds(page);
  const box = await locator.boundingBox();
  assert.ok(box);
  const x = box.x + Math.min(8, box.width / 2);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 80, { steps: 10 });
  const appeared = await page
    .locator("[data-sidebar-drop-indicator]")
    .waitFor({ timeout: 250 })
    .then(() => true)
    .catch(() => false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(appeared, false);
  assert.deepEqual(await sidebarIds(page), before);
}

try {
  const pageId = `reord${Date.now()}`;
  await seedPage(pageId, [alpha, beta, gamma]);
  await seedDocument(`page:${pageId}:block:aaaaaa`, "alpha-body");
  await seedDocument(`page:${pageId}:block:bbbbbb`, "beta-body");
  await seedDocument(`page:${pageId}:block:cccccc`, "gamma-body");

  const first = await newCountedContext();
  const page = await openWorkspace(first, pageId, 3);
  const second = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const peer = await openWorkspace(second, pageId, 3);
  await waitForCurrent(page, "aaaaaa");
  await waitForCurrent(peer, "aaaaaa");
  const fieldsBefore = fieldsById([alpha, beta, gamma]);

  await clickSidebarMove(page, "bbbbbb", "Move Up");
  await waitForSidebarIds(page, ["bbbbbb", "aaaaaa", "cccccc"]);
  assert.deepEqual(await stackedIds(page), ["bbbbbb", "aaaaaa", "cccccc"]);
  await waitForCurrent(page, "aaaaaa");

  await clickSidebarMove(page, "bbbbbb", "Move Up");
  await waitForSidebarIds(page, ["bbbbbb", "aaaaaa", "cccccc"]);
  await clickSidebarMove(page, "bbbbbb", "Move to Top");
  await waitForSidebarIds(page, ["bbbbbb", "aaaaaa", "cccccc"]);

  await clickSidebarMove(page, "cccccc", "Move Down");
  await waitForSidebarIds(page, ["bbbbbb", "aaaaaa", "cccccc"]);
  await clickSidebarMove(page, "cccccc", "Move to Bottom");
  await waitForSidebarIds(page, ["bbbbbb", "aaaaaa", "cccccc"]);

  await clickSidebarMove(page, "aaaaaa", "Move Down");
  await waitForSidebarIds(page, ["bbbbbb", "cccccc", "aaaaaa"]);
  await clickSidebarMove(page, "aaaaaa", "Move to Top");
  await waitForSidebarIds(page, ["aaaaaa", "bbbbbb", "cccccc"]);
  await clickSidebarMove(page, "cccccc", "Move to Top");
  await waitForSidebarIds(page, ["cccccc", "aaaaaa", "bbbbbb"]);
  await clickSidebarMove(page, "cccccc", "Move to Bottom");
  await waitForSidebarIds(page, ["aaaaaa", "bbbbbb", "cccccc"]);
  assert.deepEqual(await stackedIds(page), ["aaaaaa", "bbbbbb", "cccccc"]);
  assert.deepEqual(await sidebarIds(peer), ["aaaaaa", "bbbbbb", "cccccc"]);
  await waitForCurrent(page, "aaaaaa");
  await waitForCurrent(peer, "aaaaaa");
  console.log(
    "PASS menu: four directions and both boundaries; header list matches",
  );

  await page
    .locator('[data-block-panel="aaaaaa"]')
    .getByLabel("More block actions")
    .click();
  await page
    .locator('[role="menu"]:visible')
    .getByRole("menuitem", { name: "Move Down", exact: true })
    .click();
  await waitForSidebarIds(page, ["bbbbbb", "aaaaaa", "cccccc"]);
  assert.deepEqual(await stackedIds(page), ["bbbbbb", "aaaaaa", "cccccc"]);
  await clickSidebarMove(page, "bbbbbb", "Move Down");
  await waitForSidebarIds(page, ["aaaaaa", "bbbbbb", "cccccc"]);
  assert.deepEqual(await stackedIds(page), ["aaaaaa", "bbbbbb", "cccccc"]);
  console.log("PASS header: stacked menu and sidebar share one order");

  const beforeDrag = await sidebarIds(page);
  assert.deepEqual(beforeDrag, ["aaaaaa", "bbbbbb", "cccccc"]);
  const writesBeforeMouse = await manifestEditCount(page);
  const mouseDrop = await pointerDragHandle(page, "cccccc", "aaaaaa", {
    pointerType: "mouse",
    targetEdge: "start",
  });
  const mouseExpected = expectedFromInsert(
    beforeDrag,
    "cccccc",
    mouseDrop.insertBefore,
  );
  await waitForSidebarIds(page, mouseExpected);
  assert.deepEqual(await stackedIds(page), mouseExpected);
  await waitForManifest(
    pageId,
    (manifest) =>
      manifest.blocks.map((block) => block.id).join(",") ===
      mouseExpected.join(","),
    "mouse drag did not commit the indicated order",
  );
  const writesAfterMouse = await manifestEditCount(page);
  assert.equal(
    writesAfterMouse - writesBeforeMouse,
    1,
    `mouse drag should commit once, wrote ${writesAfterMouse - writesBeforeMouse}`,
  );
  await waitForCurrent(page, "aaaaaa");
  await waitForSidebarIds(peer, mouseExpected);
  await waitForCurrent(peer, "aaaaaa");
  console.log(
    `PASS mouse drag: landed before ${JSON.stringify(mouseDrop.insertBefore)} with one write`,
  );

  await restoreAbc(page);
  const writesBeforeTouch = await manifestEditCount(page);
  const touchDrop = await pointerDragHandle(page, "aaaaaa", "cccccc", {
    pointerType: "touch",
    targetEdge: "end",
  });
  const touchExpected = expectedFromInsert(
    ["aaaaaa", "bbbbbb", "cccccc"],
    "aaaaaa",
    touchDrop.insertBefore,
  );
  await waitForSidebarIds(page, touchExpected);
  await waitForManifest(
    pageId,
    (manifest) =>
      manifest.blocks.map((block) => block.id).join(",") ===
      touchExpected.join(","),
    "touch drag did not commit the indicated order",
  );
  const writesAfterTouch = await manifestEditCount(page);
  assert.equal(
    writesAfterTouch - writesBeforeTouch,
    1,
    `touch drag should commit once, wrote ${writesAfterTouch - writesBeforeTouch}`,
  );
  await waitForCurrent(page, "aaaaaa");
  await waitForCurrent(peer, "aaaaaa");
  console.log(
    `PASS touch drag: pointerType=touch landed before ${JSON.stringify(touchDrop.insertBefore)}`,
  );

  await restoreAbc(page);
  const orderBeforeCancel = await sidebarIds(page);
  const writesBeforeCancel = await manifestEditCount(page);
  await pointerDragHandle(page, "bbbbbb", "aaaaaa", {
    targetEdge: "start",
    release: "escape",
  });
  assert.deepEqual(await sidebarIds(page), orderBeforeCancel);
  assert.equal(await manifestEditCount(page), writesBeforeCancel);
  await pointerDragHandle(page, "bbbbbb", "cccccc", {
    targetEdge: "end",
    release: "outside",
  });
  assert.deepEqual(await sidebarIds(page), orderBeforeCancel);
  assert.equal(await manifestEditCount(page), writesBeforeCancel);
  await waitForManifest(
    pageId,
    (manifest) =>
      manifest.blocks.map((block) => block.id).join(",") ===
      orderBeforeCancel.join(","),
    "cancelled drag wrote a reorder",
  );
  console.log("PASS cancel: Escape and release outside commit nothing");

  await assertNoDragFrom(page, page.locator('[data-block-name="bbbbbb"]'));
  await assertNoDragFrom(page, page.locator('[data-block-language="bbbbbb"]'));
  await assertNoDragFrom(
    page,
    page.locator('[data-sidebar-reorder-menu="bbbbbb"]'),
  );
  await assertNoDragFrom(
    page,
    page.locator('nav[aria-label="Blocks"] [data-block-id="bbbbbb"]'),
  );
  await page.locator('[data-block-panel="bbbbbb"] .monaco-editor').click();
  const bodyBox = await page
    .locator('[data-block-body="bbbbbb"] .monaco-editor')
    .boundingBox();
  assert.ok(bodyBox);
  const orderBeforeBody = await sidebarIds(page);
  await page.mouse.move(bodyBox.x + 20, bodyBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(bodyBox.x + 80, bodyBox.y + 40, { steps: 8 });
  const bodyDragStarted = await page
    .locator("[data-sidebar-drop-indicator]")
    .waitFor({ timeout: 250 })
    .then(() => true)
    .catch(() => false);
  await page.mouse.up();
  assert.equal(bodyDragStarted, false);
  assert.deepEqual(await sidebarIds(page), orderBeforeBody);
  console.log(
    "PASS handle-only: name, language, menu, navigation, and body do not drag",
  );

  const committed = await fetchManifest(pageId);
  assert.ok(committed);
  assert.deepEqual(fieldsById(committed.blocks), fieldsBefore);
  assert.equal(await fetchText(`page:${pageId}:block:aaaaaa`), "alpha-body");
  assert.equal(await fetchText(`page:${pageId}:block:bbbbbb`), "beta-body");
  assert.equal(await fetchText(`page:${pageId}:block:cccccc`), "gamma-body");
  await waitForCurrent(page, "aaaaaa");
  await waitForCurrent(peer, "aaaaaa");
  console.log(
    "PASS identity: titles, languages, heights, folds, bodies, and current stay",
  );

  await second.close();
  await first.close();

  const longId = `reordlong${Date.now()}`;
  const longBlocks = Array.from({ length: 18 }, (_, index) => ({
    id: `b${String(index).padStart(5, "0")}`,
    title: `Row ${index}`,
    language: "plaintext",
    height: 200,
  }));
  await seedPage(longId, longBlocks);
  const longContext = await browser.newContext({
    viewport: { width: 1280, height: 640 },
  });
  const longPage = await openWorkspace(longContext, longId, 18);
  await longPage.locator('nav[aria-label="Blocks"]').evaluate((el) => {
    el.style.maxHeight = "160px";
    el.style.overflowY = "auto";
  });
  await longPage.locator('nav[aria-label="Blocks"]').evaluate((el) => {
    el.scrollTop = 0;
  });
  const handleBox = await longPage
    .locator('[data-sidebar-drag-handle="b00000"]')
    .boundingBox();
  const navBox = await longPage
    .locator('nav[aria-label="Blocks"]')
    .boundingBox();
  assert.ok(handleBox);
  assert.ok(navBox);
  await longPage.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await longPage.mouse.down();
  await longPage.mouse.move(
    navBox.x + navBox.width / 2,
    navBox.y + navBox.height - 6,
    {
      steps: 12,
    },
  );
  await longPage.waitForFunction(() => {
    const nav = document.querySelector('nav[aria-label="Blocks"]');
    return nav instanceof HTMLElement && nav.scrollTop > 12;
  });
  const scrolled = await longPage
    .locator('nav[aria-label="Blocks"]')
    .evaluate((el) => el.scrollTop);
  assert.ok(scrolled > 12, `expected edge auto-scroll, scrollTop=${scrolled}`);
  await longPage.keyboard.press("Escape");
  console.log(`PASS auto-scroll: list scrollTop ${scrolled} after edge drag`);
  await longContext.close();
} finally {
  await browser.close();
}
