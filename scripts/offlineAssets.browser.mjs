/**
 * Prerequisites:
 * - Run `npm run build` first. This test opens the production build, not the
 *   Vite dev server.
 * - The backend serves ./dist from the repo root. Start it with
 *   `PORT=3030 cargo run -p rustpad-server` on 127.0.0.1:3030.
 *   RUSTPAD_DIST_URL selects that origin (default: http://127.0.0.1:3030).
 * - Run `npm ci` to install playwright-core. PLAYWRIGHT_MODULE may point to an
 *   alternate Playwright module specifier or absolute module path.
 * - Install Chromium with `npx playwright-core install chromium`, or set
 *   CHROMIUM_PATH to the absolute path of an existing Chromium executable.
 *   Chromium is launched with --no-proxy-server so http_proxy is not used.
 */
import assert from "node:assert/strict";

const distUrl = process.env.RUSTPAD_DIST_URL || "http://127.0.0.1:3030";
const pageHost = new URL(distUrl).host;

try {
  const response = await fetch(distUrl, { signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(
    `Cannot reach ${distUrl}. Run npm run build first, then start the backend so it serves ./dist from the repo root. RUSTPAD_DIST_URL overrides the origin.`,
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
    args: ["--no-sandbox", "--no-proxy-server"],
  });
} catch (error) {
  console.error(
    "A Chromium binary was not found or could not be launched. Set CHROMIUM_PATH to a Chromium executable, or run npx playwright-core install chromium.",
    error,
  );
  process.exit(1);
}

const foreign = [];
const workerErrors = [];

function recordConsole(message) {
  const text = message.text();
  if (message.type() === "error" && /worker/i.test(text)) {
    workerErrors.push(text);
  }
  if (text.includes("Could not create web worker")) {
    workerErrors.push(text);
  }
}

async function openConnected(page, url) {
  await page.goto(url);
  await page.waitForFunction(
    () => (window.monaco?.editor.getEditors().length ?? 0) > 0,
  );
  await page.getByText("You are connected!", { exact: true }).waitFor();
}

try {
  const page = await browser.newPage();
  page.on("console", recordConsole);
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      host = "";
    }
    if (host !== pageHost) {
      foreign.push(url);
      await route.abort();
      return;
    }
    await route.continue();
  });

  const suffix = Date.now().toString(36);
  await openConnected(page, `${distUrl}/#page:oa${suffix}`);
  await openConnected(page, `${distUrl}/#ob${suffix}`);

  assert.deepEqual(foreign, []);
  assert.deepEqual(workerErrors, []);
  console.log("PASS offline assets stay on the page host");
} finally {
  await browser.close();
}
