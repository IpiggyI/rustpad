/**
 * Throwaway probe, not part of any suite: does opening a block page in several
 * browser contexts make the shared manifest document double?
 *
 * It listens to page:<id>:manifest from inside a browser page and records every
 * operation the server broadcasts. A full-manifest insert that arrives after
 * the document already exists is the defect: a client that believes the
 * document is empty seeds it again, the server rebases that insert onto the
 * existing text, and the manifest ends up holding two copies until some client
 * deletes one.
 *
 * Deliberately uses nothing from the feature work, so it runs unchanged against
 * an older commit for a before/after comparison.
 *
 * Prerequisites: a dev server at RUSTPAD_URL (default http://127.0.0.1:5173)
 * and the backend it proxies to. CHROMIUM_PATH selects a browser if playwright
 * cannot find its own.
 */
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const base = process.env.RUSTPAD_URL || "http://127.0.0.1:5173";
const pageId = process.env.PROBE_PAGE_ID || `probe${Date.now()}`;
const contexts = Number(process.env.PROBE_CONTEXTS || 3);

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox"],
});

/** Collect every operation the server broadcasts for the manifest document. */
async function startWatcher(context) {
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate((id) => {
    window.__ops = [];
    const uri = `${location.origin.replace(/^http/, "ws")}/api/socket/page:${id}:manifest`;
    const socket = new WebSocket(uri);
    socket.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.History === undefined) return;
      for (const entry of msg.History.operations) window.__ops.push(entry);
    };
    window.__watcher = socket;
  }, pageId);
  return page;
}

async function openBlockPage(context) {
  const page = await context.newPage();
  await page.goto(`${base}/#page:${pageId}`);
  await page.waitForFunction(
    () => window.monaco && window.monaco.editor.getEditors().length > 0,
    undefined,
    { timeout: 30000 },
  );
  await page.waitForTimeout(2500);
  return page;
}

try {
  const watcherContext = await browser.newContext();
  const watcher = await startWatcher(watcherContext);

  for (let i = 0; i < contexts; i++) {
    const context = await browser.newContext();
    try {
      await openBlockPage(context);
      console.log(`context ${i + 1}: ready`);
    } catch (error) {
      console.log(`context ${i + 1}: NOT READY - ${error.name}`);
      const page = context.pages()[0];
      console.log(
        `  editors=${await page.evaluate(() => window.monaco?.editor.getEditors().length ?? "no monaco")}`,
      );
      console.log(
        `  body=${(await page.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n/g, " | ")}`,
      );
    }
  }
  await watcher.waitForTimeout(3000);

  const ops = await watcher.evaluate(() => window.__ops);
  const isFullSeed = (entry) =>
    Array.isArray(entry.operation) &&
    typeof entry.operation[0] === "string" &&
    entry.operation[0].includes('"blocks"');
  const lateSeeds = ops.filter(
    (entry, index) => index > 0 && isFullSeed(entry),
  );
  const withDelete = ops.filter(
    (entry) =>
      Array.isArray(entry.operation) &&
      entry.operation.some((part) => typeof part === "number" && part < 0),
  );

  console.log(`pageId=${pageId} contexts=${contexts}`);
  console.log(`total operations=${ops.length}`);
  console.log(`LATE full-manifest inserts=${lateSeeds.length}`);
  for (const entry of lateSeeds) {
    console.log(
      `  revision=${entry.revision} ${JSON.stringify(entry.operation).slice(0, 120)}`,
    );
  }
  console.log(`operations containing a delete=${withDelete.length}`);
  for (const entry of withDelete) {
    console.log(
      `  revision=${entry.revision} ${JSON.stringify(entry.operation).slice(0, 120)}`,
    );
  }
  console.log(lateSeeds.length === 0 ? "RESULT: CLEAN" : "RESULT: DOUBLING");
} finally {
  await browser.close();
}
