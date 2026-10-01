/**
 * Prerequisites for `npm run test:browser`:
 * - Run `npm ci` to install playwright-core. PLAYWRIGHT_MODULE may point to an
 *   alternate Playwright module specifier or absolute module path.
 * - Start the dev server with `npm run dev` bound on 0.0.0.0:5173.
 *   RUSTPAD_LAN_URL must be a non-secure origin for that server, for example
 *   http://192.168.2.100:5173. The variable has no default.
 * - The same server must also answer on http://127.0.0.1:5173. This script
 *   reads the clipboard back from a second page on that origin.
 * - Start the backend with `PORT=3030 cargo run -p rustpad-server` on
 *   127.0.0.1:3030, the /api proxy target in vite.config.ts.
 * - Install Chromium with `npx playwright-core install chromium`, or set
 *   CHROMIUM_PATH to the absolute path of an existing Chromium executable.
 *   Chromium is launched with --no-proxy-server so http_proxy is not used.
 */
import assert from "node:assert/strict";

const lanUrl = process.env.RUSTPAD_LAN_URL;
const readBackUrl = "http://127.0.0.1:5173";

if (!lanUrl) {
  console.error(
    "RUSTPAD_LAN_URL is unset. Set RUSTPAD_LAN_URL to a non-secure origin serving the app, for example http://192.168.2.100:5173.",
  );
  process.exit(1);
}

async function assertReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(
      `Cannot reach ${url}. The dev server must be running and RUSTPAD_LAN_URL must point at it.`,
      error,
    );
    process.exit(1);
  }
}

await assertReachable(lanUrl);
await assertReachable(readBackUrl);

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
    args: ["--no-sandbox", "--no-proxy-server"],
  });
} catch (error) {
  console.error(
    "A Chromium binary was not found or could not be launched. Set CHROMIUM_PATH to a Chromium executable, or run npx playwright-core install chromium.",
    error,
  );
  process.exit(1);
}

const origin = new URL(lanUrl).origin;
const singleId = `cf${Date.now().toString(36)}`;
const pageId = `pg${Date.now().toString(36)}`;

function contentCopyButton(page) {
  return page
    .getByRole("button", { name: "Export", exact: true })
    .locator("xpath=..")
    .getByRole("button", { name: "Copy", exact: true });
}

function linkCopyButton(page) {
  return page
    .locator("input[readonly]")
    .locator("xpath=..")
    .getByRole("button", { name: "Copy", exact: true });
}

async function openEditor(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.monaco?.editor.getEditors().length);
  assert.deepEqual(
    await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => new URL(name).host !== location.host),
    ),
    [],
  );
  await page.getByText("You are connected!", { exact: true }).waitFor();
}

async function readClipboard(reader) {
  await reader.bringToFront();
  return reader.evaluate(() => navigator.clipboard.readText());
}

async function expectCopied(page, reader, label, click) {
  const copied = page.getByText("Copied!", { exact: true });
  const failed = page.getByText("Copy failed", { exact: true });
  await click();
  const which = await Promise.race([
    copied.waitFor({ timeout: 15000 }).then(
      () => "copied",
      () => "timeout",
    ),
    failed.waitFor({ timeout: 15000 }).then(
      () => "failed",
      () => "timeout",
    ),
  ]);
  assert.equal(which, "copied", `${label} did not show Copied!`);
  assert.equal(
    await page.evaluate(
      () => document.querySelectorAll("[data-rustpad-copy-fallback]").length,
    ),
    0,
    `${label} left a fallback textarea in the document`,
  );
  const text = await readClipboard(reader);
  await page.bringToFront();
  await copied.waitFor({ state: "hidden", timeout: 6000 });
  return text;
}

async function editorState(page) {
  return page.evaluate(() => {
    const editor = window.monaco.editor.getEditors()[0];
    return {
      value: editor.getValue(),
      position: editor.getPosition(),
      hasTextFocus: editor.hasTextFocus(),
    };
  });
}

async function typeIntoEditor(page, text) {
  await page.locator(".monaco-editor").first().click();
  await page.waitForFunction(() =>
    window.monaco.editor.getEditors()[0].hasTextFocus(),
  );
  await page.keyboard.type(text);
  await page.waitForFunction(
    (expected) =>
      window.monaco.editor.getEditors()[0].getValue().endsWith(expected),
    text,
  );
}

async function waitForServerText(docId, expected) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 10000) {
    const response = await fetch(new URL(`api/text/${docId}`, readBackUrl));
    last = await response.text();
    if (last === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `server text for ${docId} did not become ${JSON.stringify(expected)}; last=${JSON.stringify(last)}`,
  );
}

try {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read"], {
    origin: readBackUrl,
  });
  const page = await context.newPage();
  const reader = await context.newPage();
  await reader.goto(readBackUrl, { waitUntil: "domcontentloaded" });
  assert.equal(
    await reader.evaluate(() => window.isSecureContext),
    true,
    "clipboard read-back requires the loopback origin to be a secure context",
  );

  await openEditor(page, new URL(`/#${singleId}`, lanUrl).href);
  const contextState = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasClipboard: navigator.clipboard != null,
  }));
  assert.equal(contextState.isSecureContext, false);
  assert.equal(
    contextState.hasClipboard,
    false,
    "a non-secure origin must exercise the execCommand fallback",
  );

  const singleLink = `${origin}/#${singleId}`;
  assert.equal(await page.locator("input[readonly]").inputValue(), singleLink);
  assert.equal(
    await expectCopied(page, reader, "single-document link", () =>
      linkCopyButton(page).click(),
    ),
    singleLink,
  );
  console.log("PASS single-document link copy");

  await typeIntoEditor(page, "single-body");
  await page.keyboard.press("ArrowLeft");
  await page.evaluate(() => {
    const exportButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Export",
    );
    const copyButton = [
      ...exportButton.parentElement.querySelectorAll("button"),
    ].find((button) => button.textContent?.trim() === "Copy");
    copyButton.addEventListener(
      "mousedown",
      (event) => event.preventDefault(),
      { once: true },
    );
  });
  const beforeContentCopy = await editorState(page);
  assert.equal(beforeContentCopy.value, "single-body");
  assert.equal(beforeContentCopy.hasTextFocus, true);
  assert.equal(
    await expectCopied(page, reader, "single-document content", () =>
      contentCopyButton(page).click(),
    ),
    "single-body",
  );
  const afterContentCopy = await editorState(page);
  assert.equal(afterContentCopy.value, beforeContentCopy.value);
  assert.deepEqual(afterContentCopy.position, beforeContentCopy.position);
  assert.equal(afterContentCopy.hasTextFocus, true);
  console.log(
    "PASS single-document content copy keeps the editor text and caret",
  );

  await openEditor(page, new URL(`/#page:${pageId}`, lanUrl).href);
  assert.equal(await page.evaluate(() => window.isSecureContext), false);
  const blockLink = `${origin}/#page:${pageId}`;
  assert.equal(await page.locator("input[readonly]").inputValue(), blockLink);
  assert.equal(
    await expectCopied(page, reader, "block link", () =>
      linkCopyButton(page).click(),
    ),
    blockLink,
  );
  console.log("PASS block-mode link copy");

  await typeIntoEditor(page, "block-body");
  const blockId = await page
    .locator("[data-block-panel]")
    .getAttribute("data-block-panel");
  const blockValue = await page.evaluate(() =>
    window.monaco.editor.getEditors()[0].getValue(),
  );
  await waitForServerText(`page:${pageId}:block:${blockId}`, blockValue);
  assert.equal(
    await expectCopied(page, reader, "block copy-all", () =>
      contentCopyButton(page).click(),
    ),
    blockValue,
  );
  console.log("PASS block-mode copy-all");

  await typeIntoEditor(page, "-more");
  const blockValueMore = await page.evaluate(() =>
    window.monaco.editor.getEditors()[0].getValue(),
  );
  assert.equal(blockValueMore, `${blockValue}-more`);
  await waitForServerText(`page:${pageId}:block:${blockId}`, blockValueMore);
  const beforeBlockCopy = await editorState(page);
  assert.equal(
    await expectCopied(page, reader, "block content", () =>
      page.getByLabel("Copy block content").click(),
    ),
    blockValueMore,
  );
  const afterBlockCopy = await editorState(page);
  assert.equal(afterBlockCopy.value, beforeBlockCopy.value);
  assert.deepEqual(afterBlockCopy.position, beforeBlockCopy.position);
  console.log("PASS block-mode block content copy keeps the editor text");

  const preserved = await readClipboard(reader);
  await page.bringToFront();
  await page.evaluate(() => {
    document.execCommand = () => false;
  });
  await linkCopyButton(page).click();
  await page.getByText("Copy failed", { exact: true }).waitFor();
  assert.equal(await page.getByText("Copied!", { exact: true }).count(), 0);
  assert.equal(await readClipboard(reader), preserved);
  assert.equal(
    await page.evaluate(
      () => document.querySelectorAll("[data-rustpad-copy-fallback]").length,
    ),
    0,
  );
  console.log("PASS rejected execCommand reports Copy failed");

  await context.close();
} finally {
  await browser.close();
}
