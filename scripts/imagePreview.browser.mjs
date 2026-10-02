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
  assert.match(
    await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => name.includes("/min/vs/editor/editor.main.js")),
    ),
    /monaco-editor@0\.52\.2\//,
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
    const date = new Date();
    const localDate = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const url = new URL("api/images", window.location.href);
    url.searchParams.set("date", localDate);
    const response = await fetch(url, {
      method: "POST",
      body: image,
    });
    if (!response.ok)
      throw new Error(
        `Fixture upload failed: ${response.status} ${await response.text()}. Enable IMAGE_DIR on the backend.`,
      );
    const { path } = await response.json();
    if (
      !/^api\/images\/[0-9]{8}-[a-z0-9]{4}\.png$/.test(path) ||
      path.slice(11, 19) !== localDate
    )
      throw new Error(`Unexpected dated image path: ${path}`);
    return path;
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
  assert.ok(
    rect.width + 20 < width,
    "Fixture must leave blank preview space to the right.",
  );
  let blankPopups = 0;
  const countBlankPopup = () => blankPopups++;
  page.on("popup", countBlankPopup);
  await page.mouse.click(rect.x + rect.width + 10, rect.y + 8);
  await page.waitForTimeout(300);
  page.off("popup", countBlankPopup);
  assert.equal(
    blankPopups,
    0,
    "Blank space to the right of the image must not open a page.",
  );
  console.log(`PASS ${label} blank preview space opens no popup`);
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

async function assertNoExtraGutter(page) {
  const result = await page.evaluate(() => {
    const node = document.createElement("div");
    node.style.cssText =
      "position:fixed;width:800px;height:300px;left:-10000px";
    document.body.append(node);
    const bare = monaco.editor.create(node, {
      ...ed.getRawOptions(),
      glyphMargin: false,
      value: ed.getValue(),
    });
    const result = {
      actual: ed.getLayoutInfo().contentLeft,
      bare: bare.getLayoutInfo().contentLeft,
    };
    bare.getModel()?.dispose();
    bare.dispose();
    node.remove();
    return result;
  });
  assert.equal(
    result.actual,
    result.bare,
    "An editor without images must keep the bare editor gutter width.",
  );
}

async function waitCollapsed(page, count) {
  await page.waitForFunction((count) => {
    const toggles = [
      ...ed.getDomNode().querySelectorAll("[data-image-preview-toggle]"),
    ];
    const previews = [
      ...ed.getDomNode().querySelectorAll("[data-image-preview]"),
    ];
    return (
      toggles.length === count &&
      toggles.every((node) => node.title === "Expand image preview") &&
      previews.every(
        (node) =>
          parseFloat(node.style.height) === 0 ||
          getComputedStyle(node).display === "none",
      )
    );
  }, count);
}

async function waitHeadingFold(page) {
  await page.waitForFunction(() =>
    ed
      ._getViewModel()
      .getHiddenAreas()
      .some((range) => range.startLineNumber <= 2 && range.endLineNumber >= 2),
  );
}

async function collapsePersistence(context, blocks, collapseFirst) {
  const id = `pc${blocks ? "b" : "s"}${collapseFirst ? "c" : "f"}${Date.now().toString(36)}`;
  const url = new URL(base);
  url.hash = blocks ? `page:${id}` : id;
  const page = await open(context, url.href, blocks);
  await assertNoExtraGutter(page);
  const path = await uploadFixture(page);
  const reference = `![image](${path})`;
  const text = blocks
    ? `${reference}\n${reference}`
    : `# Heading ${reference}\nbody\n# Duplicate\n${reference}`;
  if (!blocks) await page.locator("select").first().selectOption("markdown");
  await page.waitForFunction(
    (language) => ed.getModel().getLanguageId() === language,
    blocks ? "plaintext" : "markdown",
  );
  await replace(page, text, blocks ? "plaintext" : "markdown");
  await expectLoaded(page, path, 2);
  const expanded = page.locator('[data-image-preview-toggle="1"]');
  await expanded.waitFor({ state: "visible" });
  const expandedLook = await expanded.textContent();
  assert.equal(await expanded.getAttribute("title"), "Collapse image preview");
  if (!blocks && !collapseFirst) {
    await foldHeading(page);
    await waitHeadingFold(page);
  }
  await expanded.click();
  await waitCollapsed(page, 2);
  assert.notEqual(await expanded.textContent(), expandedLook);
  if (!blocks && collapseFirst) {
    await foldHeading(page);
    await waitHeadingFold(page);
  }
  const stateId = blocks ? `page:${id}:manifest` : `folds:${id}`;
  const name = path.slice("api/images/".length);
  await page.waitForFunction(
    async ({ stateId, name, blocks }) => {
      const response = await fetch(
        new URL(`api/text/${stateId}`, window.location.href),
      );
      const raw = await response.text();
      try {
        const state = JSON.parse(raw);
        const names = blocks
          ? state.blocks[0].collapsedImages
          : state["@collapsedImages"];
        return names?.includes(name) && (blocks || state.markdown?.length > 0);
      } catch {
        return false;
      }
    },
    { stateId, name, blocks },
  );
  await page.reload();
  await page.waitForFunction(() => window.monaco?.editor.getEditors().length);
  await page.evaluate(() => {
    window.ed = monaco.editor.getEditors()[0];
  });
  await expectText(page, text);
  await waitCollapsed(page, 2);
  if (!blocks) await waitHeadingFold(page);
  const independent = await browser.newContext();
  try {
    const other = await open(independent, url.href, blocks);
    await expectText(other, text);
    await waitCollapsed(other, 2);
    if (!blocks) await waitHeadingFold(other);
  } finally {
    await independent.close();
  }
  await expanded.click();
  await expectLoaded(page, path, 2);
  if (!blocks) await waitHeadingFold(page);
  await replace(page, "No images remain", blocks ? "plaintext" : "markdown");
  await assertNoExtraGutter(page);
  console.log(
    `PASS ${blocks ? "block" : "single-document"} ${collapseFirst ? "collapse then fold" : "fold then collapse"} persists after reload and in independent storage; duplicate references collapse together; empty editors keep their gutter width`,
  );
  await page.close();
}

async function legacyPreview(context) {
  const path = `api/images/${"a".repeat(32)}.png`;
  const url = new URL(base);
  url.hash = `legacy${Date.now().toString(36)}`;
  const page = await open(context, url.href, false);
  await context.route(`**/${path}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await replace(page, `![image](${path})`);
  await expectLoaded(page, path, 1);
  await page.waitForFunction(() =>
    ed.getDomNode().querySelector(".detected-link"),
  );
  assert.equal(
    await page.locator("[data-image-preview] a").getAttribute("href"),
    new URL(path, page.url()).href,
  );
  await context.unroute(`**/${path}`);
  await page.close();
  console.log("PASS legacy 32-character image names still link and preview");
}

try {
  const context = await browser.newContext();
  await exercise(context, false);
  await exercise(context, true);
  await legacyPreview(context);
  await collapsePersistence(context, true, true);
  await collapsePersistence(context, false, false);
  await collapsePersistence(context, false, true);
  await context.close();
} finally {
  await browser.close();
}
