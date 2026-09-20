/**
 * Diagnostic only; requires the Vite server and backend used by test:browser.
 * Creates disposable documents. Logs only fold metadata, never document text.
 * PROBE_SCENARIO selects a case; PROBE_REPEAT repeats it; PROBE_MODE=block
 * exercises the block editor. A lost fold exits 1, a preserved fold exits 0.
 * PROBE_REFRESH_RECORD=1 replaces the stored record with the live memento before
 * closing, as a causal intervention. It is not a product fix or acceptance test.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.RUSTPAD_URL || "http://127.0.0.1:5173";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext();
const refreshRecord = process.env.PROBE_REFRESH_RECORD === "1";
const selected = process.env.PROBE_SCENARIO;
const blockMode = process.env.PROBE_MODE === "block";
const repetitions = Number(process.env.PROBE_REPEAT || 1);
const text =
  "## Open\nvisible\n\n## Folded\nfirst hidden\nlast hidden\n## Tail\nend";

function recordId(id) {
  return blockMode ? `page:${id}:manifest` : `folds:${id}`;
}

async function serverRecord(id) {
  const response = await fetch(`${base}/api/text/${recordId(id)}`);
  assert.equal(response.ok, true);
  const value = JSON.parse(await response.text());
  return blockMode ? value.blocks[0].folds : value.markdown;
}

async function seedBlock(id) {
  const socket = new WebSocket(
    `${base.replace(/^http/, "ws")}/api/socket/${recordId(id)}`,
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Seed timed out")), 8000);
      let sent = false;
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (!message.History) return;
        if (sent) {
          clearTimeout(timer);
          resolve();
          return;
        }
        assert.deepEqual(message.History.operations, []);
        sent = true;
        socket.send(
          JSON.stringify({
            Edit: {
              revision: 0,
              operation: [
                JSON.stringify({
                  version: 1,
                  compactHeights: true,
                  blocks: [
                    { id: "aaaaaa", title: "Probe", language: "markdown" },
                  ],
                }),
              ],
            },
          }),
        );
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Seed socket failed"));
      };
    });
  } finally {
    socket.close();
  }
}

async function open(id) {
  const page = await context.newPage();
  await page.goto(`${base}/#${blockMode ? "page:" : ""}${id}`);
  await page.waitForFunction(() => window.monaco?.editor.getEditors().length);
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.ed = monaco.editor.getEditors()[0];
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
  return page;
}

async function snapshot(page, id) {
  const result = await page.evaluate(
    (id) => ({
      hidden: ed
        ._getViewModel()
        .getHiddenAreas()
        .map((r) => [r.startLineNumber, r.endLineNumber]),
      live:
        ed
          .getContribution("editor.contrib.folding")
          .foldingModel?.getMemento() ?? [],
      saved: JSON.parse(
        localStorage.getItem(`single-doc:folds:${id}:markdown`) || "null",
      ),
      events: window.foldEvents,
    }),
    id,
  );
  result.server = await serverRecord(id);
  return result;
}

try {
  const scenarios = selected
    ? [selected]
    : [
        "control",
        "prefix-newline",
        "hidden-boundary",
        "heading-text",
        "append-tail",
      ];
  for (const scenario of Array.from(
    { length: repetitions },
    () => scenarios,
  ).flat()) {
    const minimal = scenario === "prefix-newline";
    const id = `fold-edit-${scenario}-${Date.now()}`;
    if (blockMode) await seedBlock(id);
    const page = await open(id);
    if (!blockMode)
      await page.locator("select").first().selectOption("markdown");
    await page.evaluate(
      async ({ text, foldLine }) => {
        ed.setValue(text);
        await ed.getContribution("editor.contrib.folding").getFoldingModel();
        ed.setPosition({ lineNumber: foldLine, column: 1 });
        await ed.getAction("editor.fold").run();
      },
      {
        text: minimal ? "visible\n## Folded\nbody" : text,
        foldLine: minimal ? 2 : 4,
      },
    );
    await page.waitForTimeout(1000);
    const before = await snapshot(page, id);
    assert.deepEqual(before.hidden, minimal ? [[3, 3]] : [[5, 6]]);
    assert.deepEqual(before.server, before.live);
    await page.evaluate(() => {
      window.foldEvents = { content: 0, hidden: 0, folding: 0, cacheWrites: 0 };
      ed.onDidChangeModelContent(() => foldEvents.content++);
      ed.onDidChangeHiddenAreas(() => foldEvents.hidden++);
      ed.getContribution("editor.contrib.folding").foldingModel.onDidChange(
        () => foldEvents.folding++,
      );
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("single-doc:folds:")) foldEvents.cacheWrites++;
        return original.call(this, key, value);
      };
    });
    if (scenario === "prefix-newline") {
      await page.evaluate(() => {
        ed.setPosition({ lineNumber: 1, column: 1 });
        ed.focus();
      });
      await page.keyboard.press("Enter");
    }
    await page.evaluate((scenario) => {
      const changes = {
        "hidden-boundary": {
          range: new monaco.Range(6, 1, 6, 1),
          text: "changed ",
        },
        "heading-text": {
          range: new monaco.Range(4, 10, 4, 10),
          text: " changed",
        },
        "append-tail": {
          range: new monaco.Range(8, 4, 8, 4),
          text: " changed",
        },
      };
      if (changes[scenario]) ed.executeEdits("probe", [changes[scenario]]);
    }, scenario);
    await page.waitForTimeout(1200);
    const after = await snapshot(page, id);
    assert.deepEqual(after.hidden, minimal ? [[4, 4]] : before.hidden);
    const bodyId = blockMode ? `page:${id}:block:aaaaaa` : id;
    assert.equal(
      await (await fetch(`${base}/api/text/${bodyId}`)).text(),
      await page.evaluate(() => ed.getValue()),
      "The edited body must reach the server before testing fold restoration",
    );
    if (refreshRecord) {
      await page.evaluate(
        async ({ recordId, blockMode }) => {
          const { default: Headless } = await import(
            "/src/rustpad-headless.ts"
          );
          const client = await new Promise((resolve) => {
            const client = new Headless({
              uri: `${location.origin.replace(/^http/, "ws")}/api/socket/${recordId}`,
              onContentReady: () => resolve(client),
            });
          });
          const map = JSON.parse(client.getContent());
          const live = ed
            .getContribution("editor.contrib.folding")
            .foldingModel.getMemento();
          if (blockMode) map.blocks[0].folds = live;
          else map.markdown = live;
          client.replaceContent(JSON.stringify(map));
          await client.dispose();
        },
        { recordId: recordId(id), blockMode },
      );
    }
    await page.close();
    const serverAfterClose = await serverRecord(id);
    if (refreshRecord) assert.deepEqual(serverAfterClose, after.live);
    const reopened = await open(id);
    await reopened.waitForTimeout(1200);
    const restored = await snapshot(reopened, id);
    console.log(
      JSON.stringify({
        scenario,
        blockMode,
        refreshRecord,
        before,
        after,
        serverAfterClose,
        restored,
      }),
    );
    if (JSON.stringify(after.hidden) !== JSON.stringify(restored.hidden))
      process.exitCode = 1;
    await reopened.close();
  }
} finally {
  await browser.close();
}
