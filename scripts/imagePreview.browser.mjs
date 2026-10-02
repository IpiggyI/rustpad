/**
 * Prerequisites for `npm run test:browser`:
 * - Run `npm ci` to install playwright-core. PLAYWRIGHT_MODULE may point to an
 *   alternate Playwright module specifier or absolute module path.
 * - Start the dev server with `npm run dev`. RUSTPAD_URL selects its URL
 *   (default: http://127.0.0.1:5173).
 * - Start the backend with `PORT=3030 IMAGE_DIR=images cargo run -p rustpad-server`
 *   on 127.0.0.1:3030, the /api proxy target in vite.config.ts.
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
  console.error(
    "Cannot load Playwright. Run npm ci or set PLAYWRIGHT_MODULE.",
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
    "Cannot launch Chromium. Set CHROMIUM_PATH or run npx playwright-core install chromium.",
    error,
  );
  process.exit(1);
}

async function open(context, url, blocks) {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.monaco?.editor.getEditors().length);
  if (!blocks)
    await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Upload image"]');
    return button && !button.disabled;
  });
  assert.deepEqual(
    await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => new URL(name).host !== location.host),
    ),
    [],
  );
  await page.evaluate(() => {
    window.ed = monaco.editor.getEditors()[0];
  });
  return page;
}

async function uploadFixture(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext("2d");
    context.fillStyle = "#3080c0";
    context.fillRect(0, 0, 800, 600);
    const image = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    const response = await fetch(new URL("api/images", window.location.href), {
      method: "POST",
      body: image,
    });
    if (!response.ok)
      throw new Error(
        `Fixture upload failed: ${response.status} ${await response.text()}. Enable IMAGE_DIR on the backend.`,
      );
    return (await response.json()).path;
  });
}

async function replace(page, text, language = "plaintext") {
  return page.evaluate(
    ({ text, language }) => {
      monaco.editor.setModelLanguage(ed.getModel(), language);
      ed.executeEdits("test.preview", [
        { range: ed.getModel().getFullModelRange(), text },
      ]);
      ed.setPosition({ lineNumber: 1, column: 1 });
      ed.setScrollTop(0);
      return ed.getModel().getVersionId();
    },
    { text, language },
  );
}

async function expectText(page, text) {
  await page.waitForFunction((expected) => ed.getValue() === expected, text);
}

async function expectLoaded(page, path, count) {
  await page.waitForFunction(
    ({ path, count }) => {
      const images = [
        ...ed.getDomNode().querySelectorAll("[data-image-preview] img"),
      ].filter(
        (image) =>
          image.parentElement.parentElement.dataset.imagePreview === path,
      );
      return (
        images.length === count &&
        images.every((image) => image.complete && image.naturalHeight > 0) &&
        images[0].getBoundingClientRect().height > 0
      );
    },
    { path, count },
  );
}

async function expectUnchanged(page, text, version) {
  assert.equal(await page.evaluate(() => ed.getValue()), text);
  assert.equal(
    await page.evaluate(() => ed.getModel().getVersionId()),
    version,
  );
}

async function foldHeading(page) {
  await page.evaluate(async () => {
    await ed.getContribution("editor.contrib.folding").getFoldingModel();
  });
  await page.waitForFunction(() => {
    const regions = ed.getContribution("editor.contrib.folding").foldingModel
      ?.regions;
    if (!regions) return false;
    for (let index = 0; index < regions.length; index++)
      if (
        regions.getStartLineNumber(index) === 1 &&
        regions.getEndLineNumber(index) === 2
      )
        return true;
    return false;
  });
  await page.evaluate(async () => {
    await ed.getAction("editor.fold").run();
  });
}

async function exercise(context, blocks) {
  const id = `pv${blocks ? "b" : "s"}${Date.now().toString(36)}`;
  const url = new URL(base);
  url.hash = blocks ? `page:${id}` : id;
  const page = await open(context, url.href, blocks);
  const peer = await open(context, url.href, blocks);
  const path = await uploadFixture(page);
  const reference = `![image](${path})`;
  const label = blocks ? "block" : "single-document";
  const body = page.locator("[data-block-body]").first();
  const bodyHeight = blocks ? (await body.boundingBox()).height : null;
  const external = "![external](https://example.com/photo.png)";
  const text = `${reference} ${reference} ${external}\nbelow`;
  let version = await replace(page, text);
  await expectText(peer, text);
  await expectLoaded(page, path, 2);
  assert.equal(await page.locator("[data-image-preview]").count(), 2);
  const image = page.locator("[data-image-preview] img").first();
  const rect = await image.boundingBox();
  const width = await page.evaluate(() => {
    const layout = ed.getLayoutInfo();
    return layout.contentWidth - layout.verticalScrollbarWidth;
  });
  assert.ok(rect.height > 0 && rect.height <= 320);
  assert.ok(rect.width <= width + 0.01);
  assert.ok(Math.abs(rect.width / rect.height - 800 / 600) < 0.01);
  await expectUnchanged(page, text, version);
  console.log(
    `PASS ${label} previews every local reference on a line, excludes external URLs, and preserves text and image ratio`,
  );

  const opened = page.waitForEvent("popup");
  await image.click();
  const original = await opened;
  await original.waitForLoadState("domcontentloaded");
  assert.equal(original.url(), new URL(path, page.url()).href);
  await original.close();
  console.log(
    `PASS ${label} clicking the preview opens the absolute original URL`,
  );

  await page.evaluate(() => {
    window.loadedPreview = ed
      .getDomNode()
      .querySelector("[data-image-preview] img");
    window.loadedHeight = loadedPreview.getBoundingClientRect().height;
    ed.executeEdits("test.previewEdit", [
      { range: new monaco.Range(2, 6, 2, 6), text: " edited" },
    ]);
  });
  await expectText(peer, `${text} edited`);
  assert.equal(
    await page.evaluate(
      () =>
        loadedPreview ===
        ed.getDomNode().querySelector("[data-image-preview] img"),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => loadedPreview.getBoundingClientRect().height === loadedHeight,
    ),
    true,
  );
  console.log(
    `PASS ${label} unrelated edits retain the loaded image node and height`,
  );

  const remote = `${reference}\nremote`;
  await replace(page, "ready for remote");
  await expectText(peer, "ready for remote");
  assert.equal(await page.locator("[data-image-preview]").count(), 0);
  await replace(peer, remote);
  await expectText(page, remote);
  await expectLoaded(page, path, 1);
  console.log(`PASS ${label} remote edits add an image preview`);
  await replace(peer, "removed remotely");
  await expectText(page, "removed remotely");
  await page.waitForFunction(
    () => ed.getDomNode().querySelectorAll("[data-image-preview]").length === 0,
  );
  console.log(`PASS ${label} deleting references remotely removes previews`);

  const missing = `![image](api/images/missing${id}.png)`;
  version = await replace(page, missing);
  const error = page.locator("[data-image-preview-error]");
  await error.waitFor({ state: "visible" });
  assert.equal(await error.textContent(), "Failed to load image.");
  await expectUnchanged(page, missing, version);
  console.log(
    `PASS ${label} missing images show a short error without editing the model`,
  );

  const folded = `# Heading\n${reference}\n# Next\ntext`;
  version = await replace(page, folded, "markdown");
  await expectLoaded(page, path, 1);
  await foldHeading(page);
  await image.waitFor({ state: "hidden" });
  await expectUnchanged(page, folded, version);
  await page.evaluate(async () => {
    await ed.getAction("editor.unfoldAll").run();
  });
  await image.waitFor({ state: "visible" });
  await expectUnchanged(page, folded, version);
  console.log(
    `PASS ${label} folding hides the preview and unfolding restores it without changing text`,
  );

  const headingReference = `# Heading ${reference}\nbody\n# Next\ntext`;
  await replace(page, headingReference, "markdown");
  await expectLoaded(page, path, 1);
  await foldHeading(page);
  await image.waitFor({ state: "visible" });
  console.log(
    `PASS ${label} a preview on a visible folded heading stays visible`,
  );
  await page.evaluate(async () => {
    await ed.getAction("editor.unfoldAll").run();
  });
  await replace(page, reference, "javascript");
  await expectLoaded(page, path, 1);
  assert.equal(
    await page.evaluate(() => ed.getModel().getLanguageId()),
    "javascript",
  );
  if (blocks) assert.equal((await body.boundingBox()).height, bodyHeight);
  console.log(
    `PASS ${label} non-Markdown language previews work and the editor body height stays fixed`,
  );
  await peer.close();
  await page.close();
}

try {
  const context = await browser.newContext();
  await exercise(context, false);
  await exercise(context, true);
  await context.close();
} finally {
  await browser.close();
}
