/**
 * Prerequisites for `npm run test:browser`:
 * - Run `npm ci` to install playwright-core. PLAYWRIGHT_MODULE may point to an
 *   alternate Playwright module specifier or absolute module path.
 * - Start the dev server with `npm run dev`. RUSTPAD_URL selects its URL
 *   (default: http://127.0.0.1:5173).
 * - Start the backend with `PORT=3030 cargo run -p rustpad-server` on
 *   127.0.0.1:3030, the /api proxy target in vite.config.ts.
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

function hashOf(url) {
  return new URL(url).hash;
}

async function fetchText(docId) {
  const response = await fetch(new URL(`api/text/${docId}`, base));
  return response.text();
}

async function waitForText(docId, needle, message) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 10000) {
    last = await fetchText(docId);
    if (last.includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${message}; last=${JSON.stringify(last)}`);
}

async function waitForManifestTitle(pageId, title) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 10000) {
    last = await fetchText(`page:${pageId}:manifest`);
    if (last.includes(`"title":${JSON.stringify(title)}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`title was not stored; last=${JSON.stringify(last)}`);
}

async function showHome(page) {
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "New page", exact: true }).waitFor();
  assert.match(hashOf(page.url()), /^$|^#$/);
}

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  await page.goto(base);
  await page.evaluate(() =>
    document.querySelector("vite-error-overlay")?.remove(),
  );
  await page.getByRole("button", { name: "New page", exact: true }).waitFor();
  assert.equal(hashOf(page.url()), "");
  assert.equal(await page.locator(".monaco-editor").count(), 0);
  await page.getByText("No recent pages", { exact: true }).waitFor();
  console.log("PASS bare URL shows the home page");

  await page.goto(`${base}/#`);
  await page.getByRole("button", { name: "New page", exact: true }).waitFor();
  assert.equal(hashOf(page.url()), "");
  assert.equal(await page.locator(".monaco-editor").count(), 0);
  console.log("PASS empty hash shows the home page");

  const singleId = "singld";
  await page.goto(`${base}/#${singleId}`);
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.location.hash = "";
  });
  await page.getByRole("button", { name: "New page", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: singleId, exact: true }).count(),
    0,
  );
  console.log("PASS a single document is not listed");

  await page.getByRole("button", { name: "New page", exact: true }).click();
  await page.waitForURL(/#page:[A-Za-z0-9]{6}$/);
  const pageId = hashOf(page.url()).slice("#page:".length);
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.getByText("(1 block)", { exact: true }).waitFor();
  await showHome(page);
  const created = page.getByRole("link", { name: pageId, exact: true });
  await created.waitFor();
  await page
    .getByRole("listitem")
    .filter({ has: created })
    .locator("time")
    .waitFor();
  console.log("PASS New page lands on #page:<id> and is listed");

  await created.click();
  await page.waitForURL(new RegExp(`#page:${pageId}$`));
  await page.getByText("You are connected!", { exact: true }).waitFor();
  const title = "Quarterly notes";
  const titleInput = page.getByLabel("Document Title", { exact: true });
  await titleInput.fill(title);
  await titleInput.blur();
  await waitForManifestTitle(pageId, title);
  await page.waitForFunction(
    () => (window.monaco?.editor.getEditors().length ?? 0) >= 1,
  );
  await page.locator("[data-block-panel] .monaco-editor").click();
  await page.keyboard.type("kept-body");
  const blockId = await page
    .locator('nav[aria-label="Blocks"] [data-block-id]')
    .first()
    .getAttribute("data-block-id");
  assert.ok(blockId, "new page has a block");
  await waitForText(
    `page:${pageId}:block:${blockId}`,
    "kept-body",
    "block body was not stored",
  );
  await showHome(page);
  const renamed = page.getByRole("link", { name: title, exact: true });
  await renamed.waitFor();
  assert.equal(
    await page.getByRole("link", { name: pageId, exact: true }).count(),
    0,
  );
  console.log("PASS renaming the title shows the new title on the home page");

  const row = page.getByRole("listitem").filter({ has: renamed });
  const apiCalls = [];
  const onRequest = (request) => {
    if (request.resourceType() === "websocket") return;
    if (request.url().includes("/api/")) apiCalls.push(request.url());
  };
  page.on("request", onRequest);
  await row
    .getByRole("button", { name: "Remove from list", exact: true })
    .click();
  page.off("request", onRequest);
  assert.deepEqual(apiCalls, []);
  assert.equal(
    await page.getByRole("link", { name: title, exact: true }).count(),
    0,
  );
  console.log("PASS removing the entry hides it without a server call");

  await page.goto(`${base}/#page:${pageId}`);
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.waitForFunction((expected) => {
    const input = document.querySelector('[aria-label="Document Title"]');
    const editors = window.monaco?.editor.getEditors() ?? [];
    return (
      input?.value === expected &&
      editors.some((editor) => editor.getValue().includes("kept-body"))
    );
  }, title);
  console.log("PASS the page link still opens the page with its content");

  await showHome(page);
  await page.getByLabel("Open page", { exact: true }).fill(pageId);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForURL(new RegExp(`#page:${pageId}$`));
  await page.getByText("You are connected!", { exact: true }).waitFor();
  console.log("PASS opening by id works");

  await showHome(page);
  await page
    .getByLabel("Open page", { exact: true })
    .fill(`${base}/#page:${pageId}`);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForURL(new RegExp(`#page:${pageId}$`));
  await page.getByText("You are connected!", { exact: true }).waitFor();
  console.log("PASS opening by full link works");

  await showHome(page);
  await page.getByLabel("Open page", { exact: true }).fill("not a page");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "page id" });
  await alert.waitFor();
  assert.match(await alert.innerText(), /page id/);
  assert.equal(hashOf(page.url()), "");
  await page.getByRole("button", { name: "New page", exact: true }).waitFor();
  assert.equal(await page.locator(".monaco-editor").count(), 0);
  console.log(
    "PASS an invalid input shows an error and stays on the home page",
  );

  await context.close();
} finally {
  await browser.close();
}
