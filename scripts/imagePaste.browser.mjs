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
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64",
);

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
  await page
    .getByRole("button", { name: "Upload image", exact: true })
    .first()
    .waitFor();
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
    window.ed = window.monaco.editor.getEditors()[0];
  });
  return page;
}

async function value(page) {
  return page.evaluate(() => ed.getValue());
}

async function expectValue(page, text) {
  await page.waitForFunction((expected) => ed.getValue() === expected, text);
}

async function prepare(page, text, range) {
  await page.evaluate(
    ({ text, range }) => {
      ed.executeEdits("test.prepare", [
        { range: ed.getModel().getFullModelRange(), text },
      ]);
      ed.setSelection(new monaco.Selection(...range));
      ed.focus();
    },
    { text, range },
  );
}

async function paste(page, text = "") {
  return page.evaluate(
    ({ bytes, text }) => {
      ed.focus();
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(bytes)], "clipboard.png", {
          type: "image/png",
        }),
      );
      data.setData("text/plain", text);
      const target = ed
        .getDomNode()
        .querySelector("textarea, [contenteditable=true]");
      if (!target) throw new Error("Monaco input was not found.");
      const event = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { bytes: [...png], text },
  );
}

async function markerCount(page) {
  return page.evaluate(
    () =>
      ed
        .getModel()
        .getAllDecorations()
        .filter(
          (decoration) =>
            decoration.options.before?.inlineClassName ===
            "image-upload-marker",
        ).length,
  );
}

async function waitForMarker(page, count) {
  await page.waitForFunction(
    (expected) =>
      ed
        .getModel()
        .getAllDecorations()
        .filter(
          (decoration) =>
            decoration.options.before?.inlineClassName ===
            "image-upload-marker",
        ).length === expected,
    count,
  );
}

async function openOriginal(page, path) {
  const expected = new URL(path, page.url()).href;
  await page.waitForFunction(
    (path) =>
      [...ed.getDomNode().querySelectorAll(".detected-link")].some((link) =>
        link.textContent.includes(path),
      ),
    path,
  );
  const point = await page.evaluate((path) => {
    const model = ed.getModel();
    const position = model.getPositionAt(model.getValue().indexOf(path) + 4);
    ed.revealPositionInCenter(position);
    const visible = ed.getScrolledVisiblePosition(position);
    const rect = ed.getDomNode().getBoundingClientRect();
    return {
      x: rect.left + visible.left + 2,
      y: rect.top + visible.top + visible.height / 2,
    };
  }, path);
  const opened = page.waitForEvent("popup");
  await page.keyboard.down("Control");
  try {
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
  } finally {
    await page.keyboard.up("Control");
  }
  const original = await opened;
  await original.waitForLoadState("domcontentloaded");
  assert.equal(original.url(), expected);
  await original.close();
}

async function exercise(context, blocks) {
  const id = `ip${blocks ? "b" : "s"}${Date.now().toString(36)}`;
  const url = new URL(base);
  url.hash = blocks ? `page:${id}` : id;
  const page = await open(context, url.href, blocks);
  const peer = await open(context, url.href, blocks);
  const label = blocks ? "block" : "single-document";
  let uploads = 0;
  let uploadDate;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/api/images")
    ) {
      uploads++;
      uploadDate = new URL(request.url()).searchParams.get("date");
    }
  });

  await prepare(page, "before\nreplace\nafter", [2, 1, 2, 8]);
  await expectValue(peer, "before\nreplace\nafter");
  await paste(page);
  await page.waitForFunction(() =>
    ed.getValue().includes("![image](api/images/"),
  );
  const firstText = await value(page);
  assert.match(
    firstText,
    /^before\n!\[image\]\(api\/images\/(?:[0-9]{8}-[a-z0-9]{4}|[a-z0-9]{32})\.png\)\nafter$/,
  );
  const localDate = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  });
  const path = firstText.match(/!\[image\]\(([^)]+)\)/)[1];
  assert.equal(uploadDate, localDate);
  const response = await context.request.get(new URL(path, page.url()).href);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["content-type"], "image/png");
  assert.deepEqual(await response.body(), png);
  await expectValue(peer, firstText);
  await waitForMarker(page, 0);
  assert.equal(uploads, 1);
  console.log(
    `PASS ${label} PNG paste replaces selection, reads back image/png, and syncs`,
  );

  await prepare(page, "", [1, 1, 1, 1]);
  await expectValue(peer, "");
  await paste(page);
  const reference = `![image](${path})`;
  await expectValue(page, reference);
  await expectValue(peer, reference);
  await waitForMarker(page, 0);
  await page.evaluate(() => ed.trigger("test", "undo", null));
  await expectValue(peer, "");
  await page.evaluate(() => ed.trigger("test", "redo", null));
  await expectValue(peer, reference);
  console.log(
    `PASS ${label} deleting and pasting again reuses the image path, including undo and redo`,
  );

  await prepare(page, "", [1, 1, 1, 1]);
  await expectValue(peer, "");
  const beforeTextPaste = uploads;
  await paste(page, "plain text wins");
  await expectValue(page, "plain text wins");
  await expectValue(peer, "plain text wins");
  assert.equal(uploads, beforeTextPaste);
  assert.equal(await markerCount(page), 0);
  console.log(
    `PASS ${label} non-empty text/plain pastes text without an upload`,
  );

  await prepare(page, "above\ntarget\nbelow", [2, 1, 2, 1]);
  await expectValue(peer, "above\ntarget\nbelow");
  let release;
  let received;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    received = resolve;
  });
  const route = async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200, "The backend must enable IMAGE_DIR.");
    received();
    await held;
    await route.fulfill({ response });
  };
  await page.route(/\/api\/images(?:\?.*)?$/, route);
  try {
    await paste(page);
    await Promise.race([
      started,
      page.waitForTimeout(10000).then(() => {
        throw new Error("No successful upload response arrived.");
      }),
    ]);
    await waitForMarker(page, 1);
    await page.waitForFunction(() =>
      ed.getDomNode().textContent.includes("[Uploading...]"),
    );
    assert.equal(await value(page), "above\ntarget\nbelow");
    assert.equal(await value(peer), "above\ntarget\nbelow");
    assert.equal(await markerCount(peer), 0);
    assert.equal(
      await peer.evaluate(() =>
        ed.getDomNode().textContent.includes("[Uploading...]"),
      ),
      false,
    );
    await peer.evaluate(() => {
      ed.executeEdits("test.remote", [
        { range: new monaco.Range(1, 1, 1, 1), text: "remote\n" },
      ]);
    });
    await expectValue(page, "remote\nabove\ntarget\nbelow");
    assert.equal(await markerCount(page), 1);
    release();
    await page.waitForFunction(() =>
      ed.getValue().includes("![image](api/images/"),
    );
    const trackedText = await value(page);
    assert.match(
      trackedText,
      /^remote\nabove\n!\[image\]\(api\/images\/(?:[0-9]{8}-[a-z0-9]{4}|[a-z0-9]{32})\.png\)target\nbelow$/,
    );
    await expectValue(peer, trackedText);
    await waitForMarker(page, 0);
    console.log(
      `PASS ${label} upload marker stays local and tracks remote OT edits`,
    );
    await openOriginal(page, trackedText.match(/!\[image\]\(([^)]+)\)/)[1]);
    console.log(
      `PASS ${label} Ctrl+click opens the absolute original URL in a new page`,
    );
  } finally {
    release();
    await page.unroute(/\/api\/images(?:\?.*)?$/, route);
  }

  await prepare(page, "replace", [1, 1, 1, 8]);
  await expectValue(peer, "replace");
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Upload image", exact: true })
    .first()
    .click();
  const picker = await chooser;
  assert.equal(picker.isMultiple(), true);
  assert.equal(
    await picker.element().getAttribute("accept"),
    "image/png,image/jpeg,image/gif,image/webp",
  );
  await picker.setFiles([
    { name: "first.png", mimeType: "image/png", buffer: png },
    { name: "second.png", mimeType: "image/png", buffer: png },
  ]);
  await page.waitForFunction(
    () => ed.getValue().split("![image]").length === 3,
  );
  const pickedText = await value(page);
  assert.match(
    pickedText,
    /^!\[image\]\(api\/images\/(?:[0-9]{8}-[a-z0-9]{4}|[a-z0-9]{32})\.png\)\n!\[image\]\(api\/images\/(?:[0-9]{8}-[a-z0-9]{4}|[a-z0-9]{32})\.png\)$/,
  );
  await expectValue(peer, pickedText);
  assert.equal(pickedText, `${reference}\n${reference}`);
  console.log(
    `PASS ${label} upload button accepts multiple images and replaces selection`,
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
