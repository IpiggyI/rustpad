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

const tall = {
  id: "aaaaaa",
  title: "Tall",
  language: "plaintext",
  height: 480,
};
const short = {
  id: "bbbbbb",
  title: "Short",
  language: "plaintext",
  height: 120,
};
const folded = {
  id: "cccccc",
  title: "Folded",
  language: "plaintext",
  height: 360,
  collapsed: true,
};

const unmarkedManifest = {
  version: 1,
  title: "compact-heights",
  blocks: [tall, short, folded],
};

function wsUrl(docId) {
  const url = new URL(`api/socket/${docId}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function snapshotKey(pageId) {
  return `${SNAPSHOT_PREFIX}${pageId}`;
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

function trackSnapshots(payload) {
  const orig = Storage.prototype.setItem;
  globalThis.__rustpadSnapshotWrites = [];
  Storage.prototype.setItem = function (key, value) {
    if (String(key).startsWith("block-workspace:snapshot:")) {
      globalThis.__rustpadSnapshotWrites.push(String(value));
    }
    return orig.call(this, key, value);
  };
  if (payload) {
    localStorage.setItem(payload.key, payload.value);
    globalThis.__rustpadSnapshotWrites = [];
  }
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
  return page;
}

async function renderedBodyHeights(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[title="Drag to resize"]')].map((handle) =>
      Math.round(handle.previousElementSibling.getBoundingClientRect().height),
    ),
  );
}

async function waitForBodies(page, expected) {
  await page.waitForFunction((wanted) => {
    const heights = [
      ...document.querySelectorAll('[title="Drag to resize"]'),
    ].map((handle) =>
      Math.round(handle.previousElementSibling.getBoundingClientRect().height),
    );
    return (
      heights.length === wanted.length &&
      heights.every((height, i) => height === wanted[i])
    );
  }, expected);
  assert.deepEqual(await renderedBodyHeights(page), expected);
}

async function readStoredSnapshot(page, pageId) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, snapshotKey(pageId));
}

async function waitForStoredMarker(page, pageId) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 8000) {
    last = await readStoredSnapshot(page, pageId);
    if (last?.compactHeights === true) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const writes = await page.evaluate(() => globalThis.__rustpadSnapshotWrites);
  assert.equal(
    last?.compactHeights,
    true,
    `snapshot write dropped compactHeights: ${JSON.stringify(last)}; writes=${JSON.stringify(writes)}`,
  );
  return last;
}

async function assertStoredMarker(page, pageId) {
  const stored = await readStoredSnapshot(page, pageId);
  assert.equal(
    stored?.compactHeights,
    true,
    `snapshot write dropped compactHeights: ${JSON.stringify(stored)}`,
  );
  return stored;
}

// Wait for the write's payload, then assert the marker, so a dropped
// compactHeights fails the equality check instead of this wait.
async function waitForStoredSnapshot(page, pageId, predicate, message) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 8000) {
    last = await readStoredSnapshot(page, pageId);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${message}; last=${JSON.stringify(last)}`);
}

async function dragFirstBody(page, deltaY) {
  const handle = page.locator('[title="Drag to resize"]').first();
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  assert.ok(box, "expected a resize handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaY, { steps: 12 });
  await page.mouse.up();
}

try {
  const markerPageId = `snapmark${Date.now()}`;
  const collapsedSeed = {
    version: 1,
    title: "snapshot-marker",
    blocks: [
      { ...tall, collapsed: true },
      { ...short, collapsed: true },
      { ...folded, collapsed: true },
    ],
  };
  await seedManifest(markerPageId, collapsedSeed);
  await waitForManifest(
    markerPageId,
    (manifest) =>
      manifest.blocks?.length === 3 && manifest.compactHeights !== true,
    "server never received the collapsed unmarked seed",
  );

  const markerCtx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await markerCtx.addInitScript(trackSnapshots);
  const markerPage = await openPage(markerCtx, markerPageId);
  await waitForManifest(
    markerPageId,
    (manifest) =>
      manifest.compactHeights === true &&
      manifest.blocks.every(
        (block) => block.height === 200 && block.collapsed === true,
      ),
    "collapsed page was not migrated",
  );
  const afterLayoutSave = await waitForStoredSnapshot(
    markerPage,
    markerPageId,
    (stored) =>
      stored.blocks?.length === 3 &&
      stored.blocks.every(
        (block) => block.height === 200 && block.collapsed === true,
      ),
    "saveCurrentSnapshot never stored the migrated snapshot",
  );
  assert.equal(
    afterLayoutSave.compactHeights,
    true,
    `snapshot write dropped compactHeights: ${JSON.stringify(afterLayoutSave)}`,
  );
  console.log("PASS snapshot saveCurrentSnapshot writes compactHeights");

  await markerPage.getByLabel("Toggle block").first().click();
  await markerPage.waitForFunction(
    () => window.monaco?.editor.getEditors().length >= 1,
  );
  await markerPage.evaluate(() => {
    window.monaco.editor.getEditors()[0].focus();
  });
  await markerPage.keyboard.type("x");
  const afterContentSave = await waitForStoredSnapshot(
    markerPage,
    markerPageId,
    (stored) =>
      stored.blocks?.some(
        (block) =>
          typeof block.content === "string" && block.content.includes("x"),
      ),
    "rememberBlockContent never stored typed content",
  );
  assert.equal(
    afterContentSave.compactHeights,
    true,
    `snapshot write dropped compactHeights: ${JSON.stringify(afterContentSave)}`,
  );
  console.log("PASS snapshot rememberBlockContent writes compactHeights");
  await markerCtx.close();

  const pageId = `compacth${Date.now()}`;
  await seedManifest(pageId, unmarkedManifest);
  const seeded = await waitForManifest(
    pageId,
    (manifest) =>
      manifest.blocks?.length === 3 && manifest.compactHeights !== true,
    "server never received the unmarked seed",
  );
  assert.equal(seeded.blocks[0].height, 480);
  assert.equal(seeded.blocks[1].height, 120);
  assert.equal(seeded.blocks[2].height, 360);
  assert.equal(seeded.blocks[2].collapsed, true);

  const first = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await first.addInitScript(trackSnapshots);
  const page = await openPage(first, pageId);

  const migrated = await waitForManifest(
    pageId,
    (manifest) =>
      manifest.compactHeights === true &&
      manifest.blocks?.length === 3 &&
      manifest.blocks.every((block) => block.height === 200),
    "server manifest was not migrated to 200px with compactHeights",
  );
  assert.equal(migrated.title, "compact-heights");
  assert.equal(migrated.blocks[0].id, "aaaaaa");
  assert.equal(migrated.blocks[0].title, "Tall");
  assert.equal(migrated.blocks[0].language, "plaintext");
  assert.equal(migrated.blocks[1].id, "bbbbbb");
  assert.equal(migrated.blocks[2].collapsed, true);
  assert.equal(migrated.blocks[2].height, 200);

  await waitForBodies(page, [200, 200]);
  const stored = await waitForStoredMarker(page, pageId);
  assert.equal(stored.blocks[0].height, 200);
  assert.equal(stored.blocks[1].height, 200);
  assert.equal(stored.blocks[2].height, 200);
  assert.equal(stored.blocks[2].collapsed, true);
  await page.waitForTimeout(800);
  await assertStoredMarker(page, pageId);
  console.log(
    "PASS first open: unmarked mixed heights including collapsed migrated to 200px bodies, marker written",
  );

  await page.getByLabel("Toggle block").nth(2).click();
  await waitForBodies(page, [200, 200, 200]);
  console.log("PASS first open: collapsed block body is 200px after expand");

  await dragFirstBody(page, 250);
  await page.waitForFunction(() => {
    const handle = document.querySelector('[title="Drag to resize"]');
    if (!handle) return false;
    const height = Math.round(
      handle.previousElementSibling.getBoundingClientRect().height,
    );
    return height >= 280 && height !== 200;
  });
  const afterDrag = await renderedBodyHeights(page);
  const manualHeight = afterDrag[0];
  assert.ok(
    manualHeight >= 280 && manualHeight !== 200,
    `drag should leave a height other than 200, got ${manualHeight}`,
  );
  await waitForManifest(
    pageId,
    (manifest) =>
      manifest.compactHeights === true &&
      manifest.blocks[0].height === manualHeight,
    "dragged height did not persist to the server manifest",
  );
  await assertStoredMarker(page, pageId);

  await page.reload();
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.getByText("(3 blocks)", { exact: true }).waitFor();
  await waitForBodies(page, [manualHeight, 200, 200]);
  const reloaded = await waitForManifest(
    pageId,
    (manifest) =>
      manifest.compactHeights === true &&
      manifest.blocks[0].height === manualHeight,
    "reload re-migrated the dragged height",
  );
  assert.equal(reloaded.blocks[0].height, manualHeight);
  await waitForStoredMarker(page, pageId);
  await assertStoredMarker(page, pageId);
  console.log(
    `PASS reload: dragged height ${manualHeight}px survived and did not snap to 200`,
  );
  await first.close();

  const second = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const peer = await openPage(second, pageId);
  await waitForBodies(peer, [manualHeight, 200, 200]);
  const peerManifest = await fetchManifest(pageId);
  assert.equal(peerManifest.compactHeights, true);
  assert.equal(peerManifest.blocks[0].height, manualHeight);
  console.log(
    "PASS second context: empty localStorage sees the manual height and does not re-migrate",
  );
  await second.close();

  const stale = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await stale.addInitScript(trackSnapshots, {
    key: snapshotKey(pageId),
    value: JSON.stringify({
      version: 1,
      blocks: [
        { ...tall, content: "" },
        { ...short, content: "" },
        { ...folded, content: "" },
      ],
    }),
  });
  const stalePage = await openPage(stale, pageId);
  await waitForBodies(stalePage, [manualHeight, 200, 200]);
  const staleManifest = await fetchManifest(pageId);
  assert.equal(staleManifest.compactHeights, true);
  assert.equal(staleManifest.blocks[0].height, manualHeight);
  assert.notEqual(staleManifest.blocks[0].height, 480);
  await waitForStoredMarker(stalePage, pageId);
  await assertStoredMarker(stalePage, pageId);
  console.log(
    "PASS stale snapshot: unmarked local cache does not re-run migration",
  );
  await stale.close();
} finally {
  await browser.close();
}
