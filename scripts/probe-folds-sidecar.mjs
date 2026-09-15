/**
 * Throwaway probe, not part of any suite: does the single-document fold sidecar
 * (folds:<id>) suffer the same late-seed doubling as the block manifest, and can
 * a fold record be replaced by an empty one?
 *
 * Why it matters: single-document folds live in a sidecar collaboration document
 * written through the same RustpadHeadless.replaceContent path as the manifest.
 * On load, a parseable sidecar wins outright and the localStorage copy is not
 * merged, so a sidecar that ends up holding an empty record discards the folds
 * this device still had.
 *
 * Prerequisites: a dev server at RUSTPAD_URL and the backend it proxies to.
 */
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const base = process.env.RUSTPAD_URL || "http://127.0.0.1:5173";
const docId = process.env.PROBE_DOC_ID || `folds${Date.now()}`;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox"],
});

const heading = ["## One", "body one", "## Two", "body two"].join("\n");

async function startWatcher(context, id) {
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate((watched) => {
    window.__ops = [];
    const uri = `${location.origin.replace(/^http/, "ws")}/api/socket/folds:${watched}`;
    const socket = new WebSocket(uri);
    socket.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.History === undefined) return;
      for (const entry of msg.History.operations) window.__ops.push(entry);
    };
    window.__watcher = socket;
  }, id);
  return page;
}

async function openDoc(context, id) {
  const page = await context.newPage();
  await page.goto(`${base}/#${id}`);
  await page.waitForFunction(
    () => window.monaco && window.monaco.editor.getEditors().length > 0,
    undefined,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1500);
  return page;
}

async function setMarkdown(page, text) {
  await page.locator("select").first().selectOption("markdown");
  await page.waitForTimeout(500);
  await page.evaluate((value) => {
    const editor = window.monaco.editor.getEditors()[0];
    editor.getModel().setValue(value);
  }, text);
  await page.waitForTimeout(1500);
}

/** Collapse the first heading through Monaco's folding action. */
async function foldFirstHeading(page) {
  await page.evaluate(() => {
    const editor = window.monaco.editor.getEditors()[0];
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.getAction("editor.fold").run();
  });
  await page.waitForTimeout(2000);
}

async function hiddenLineCount(page) {
  return page.evaluate(() => {
    const editor = window.monaco.editor.getEditors()[0];
    let hidden = 0;
    const ranges = editor._modelData?.viewModel?.getHiddenAreas?.() ?? [];
    for (const range of ranges) {
      hidden += range.endLineNumber - range.startLineNumber + 1;
    }
    return hidden;
  });
}

async function localFolds(page, id) {
  return page.evaluate((watched) => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`single-doc:folds:${watched}`)) {
        out[key] = localStorage.getItem(key);
      }
    }
    return out;
  }, id);
}

try {
  const watcherContext = await browser.newContext();
  const watcher = await startWatcher(watcherContext, docId);

  const first = await browser.newContext();
  const page = await openDoc(first, docId);
  await setMarkdown(page, heading);
  await foldFirstHeading(page);
  const hiddenAfterFold = await hiddenLineCount(page);
  const localAfterFold = await localFolds(page, docId);
  console.log(`hidden lines after folding=${hiddenAfterFold}`);
  console.log(`localStorage after folding=${JSON.stringify(localAfterFold)}`);

  // A second device opening the same document, the way a phone would.
  const second = await browser.newContext();
  const peer = await openDoc(second, docId);
  await peer.waitForTimeout(2500);
  const peerHidden = await hiddenLineCount(peer);
  console.log(`peer hidden lines=${peerHidden}`);

  // Close both, then reopen in a third context with NO local cache at all.
  await page.close();
  await peer.close();
  await watcher.waitForTimeout(2000);

  const third = await browser.newContext();
  const reopened = await openDoc(third, docId);
  await reopened.waitForTimeout(3000);
  const reopenedHidden = await hiddenLineCount(reopened);
  console.log(`fresh context hidden lines=${reopenedHidden}`);

  const ops = await watcher.evaluate(() => window.__ops);
  console.log(`sidecar operations=${ops.length}`);
  for (const entry of ops) {
    console.log(`  ${JSON.stringify(entry.operation).slice(0, 140)}`);
  }
  const lateSeeds = ops.filter(
    (entry, index) =>
      index > 0 &&
      Array.isArray(entry.operation) &&
      typeof entry.operation[0] === "string" &&
      entry.operation[0].trim().startsWith("{"),
  );
  console.log(`LATE sidecar seeds=${lateSeeds.length}`);
  console.log(
    reopenedHidden > 0
      ? "RESULT: folds survived a fresh context"
      : "RESULT: folds LOST in a fresh context",
  );
} finally {
  await browser.close();
}
