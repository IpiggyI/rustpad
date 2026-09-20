/**
 * Diagnostic loop for: three headings, fold the first and last, type
 * several lines in the middle, close, reopen. Exit 1 if the last heading
 * is expanded after reopen. Logs fold metadata only.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.RUSTPAD_URL || "http://127.0.0.1:5173";
const waitMs = Number(process.env.PROBE_WAIT_MS ?? 800);
const selected = process.env.PROBE_SCENARIO || "middle-enters";
const blockMode = process.env.PROBE_MODE === "block";
const repetitions = Number(process.env.PROBE_REPEAT || 1);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});

function recordId(id) {
  return blockMode ? `page:${id}:manifest` : `folds:${id}`;
}

async function serverRecord(id) {
  const response = await fetch(`${base}/api/text/${recordId(id)}`);
  if (!response.ok) return { error: response.status };
  const value = JSON.parse(await response.text());
  return blockMode ? value.blocks?.[0]?.folds : value.markdown;
}

async function open(context, id) {
  const page = await context.newPage();
  await page.goto(`${base}/#${blockMode ? "page:" : ""}${id}`);
  await page.waitForFunction(() => window.monaco?.editor.getEditors().length);
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.ed = monaco.editor.getEditors()[0];
  });
  return page;
}

async function snapshot(page, id) {
  const result = await page.evaluate(() => {
    const model = ed.getModel();
    const folding = ed.getContribution("editor.contrib.folding").foldingModel;
    return {
      hidden: ed
        ._getViewModel()
        .getHiddenAreas()
        .map((r) => [r.startLineNumber, r.endLineNumber]),
      live: folding?.getMemento() ?? [],
      collapsed: Array.from({ length: folding?.regions.length ?? 0 }, (_, i) => ({
        start: folding.regions.getStartLineNumber(i),
        end: folding.regions.getEndLineNumber(i),
        collapsed: folding.regions.isCollapsed(i),
        source: folding.regions.getSource(i),
        line: model.getLineContent(folding.regions.getStartLineNumber(i)),
      })),
      lineCount: model.getLineCount(),
    };
  });
  result.server = await serverRecord(id);
  result.saved = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem(`single-doc:folds:${id}:markdown`) || "null"),
    id,
  );
  return result;
}

try {
  for (let round = 0; round < repetitions; round++) {
    const context = await browser.newContext();
    const id = `three-headings-${selected}-${Date.now()}-${round}`;
    const page = await open(context, id);
    if (!blockMode)
      await page.locator("select").first().selectOption("markdown");
    await page.evaluate(async () => {
      ed.setValue("## Top\ntop body\n## Mid\nmid body\n## Bottom\nbottom body");
      await ed.getContribution("editor.contrib.folding").getFoldingModel();
      ed.setPosition({ lineNumber: 1, column: 1 });
      await ed.getAction("editor.fold").run();
      ed.setPosition({ lineNumber: 5, column: 1 });
      await ed.getAction("editor.fold").run();
    });
    await page.waitForTimeout(700);
    const before = await snapshot(page, id);
    assert.deepEqual(
      before.hidden,
      [
        [2, 2],
        [6, 6],
      ],
      `setup hidden ${JSON.stringify(before)}`,
    );

    await page.evaluate(() => {
      ed.setPosition({
        lineNumber: 4,
        column: ed.getModel().getLineMaxColumn(4),
      });
      ed.focus();
    });

    if (selected === "middle-enters") {
      for (const text of ["one", "two", "three"]) {
        await page.keyboard.press("Enter");
        await page.keyboard.insertText(text);
      }
    } else if (selected === "middle-enters-no-wait") {
      for (const text of ["one", "two", "three"]) {
        await page.keyboard.press("Enter");
        await page.keyboard.insertText(text);
      }
    } else if (selected === "middle-heading-enter") {
      await page.evaluate(() => {
        ed.setPosition({
          lineNumber: 3,
          column: ed.getModel().getLineMaxColumn(3),
        });
        ed.focus();
      });
      await page.keyboard.press("Enter");
      await page.keyboard.insertText("new heading body");
      await page.keyboard.press("Enter");
      await page.keyboard.insertText("more");
    } else if (selected === "middle-blank-enters") {
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
    } else {
      throw new Error(`unknown scenario ${selected}`);
    }

    const afterWait = selected === "middle-enters-no-wait" ? 0 : waitMs;
    if (afterWait) await page.waitForTimeout(afterWait);
    const after = await snapshot(page, id);
    const bodyId = blockMode ? `page:${id}:block:aaaaaa` : id;
    const serverBody = await (await fetch(`${base}/api/text/${bodyId}`)).text();
    const editorBody = await page.evaluate(() => ed.getValue());
    await page.close();
    const serverAfterClose = await serverRecord(id);
    const reopened = await open(context, id);
    await reopened.waitForTimeout(1000);
    const restored = await snapshot(reopened, id);
    const bottomStillFolded = restored.hidden.some(
      ([start, end]) =>
        restored.collapsed.find(
          (r) =>
            r.collapsed &&
            r.start === start &&
            r.end === end &&
            r.line.startsWith("## Bottom"),
        ) || restored.collapsed.some((r) => r.collapsed && r.line.startsWith("## Bottom")),
    );
    const topStillFolded = restored.collapsed.some(
      (r) => r.collapsed && r.line.startsWith("## Top"),
    );
    const report = {
      round,
      selected,
      waitMs: afterWait,
      bodySynced: serverBody === editorBody,
      beforeHidden: before.hidden,
      afterHidden: after.hidden,
      afterLive: after.live,
      afterServer: after.server,
      serverAfterClose,
      restoredHidden: restored.hidden,
      restoredLive: restored.live,
      restoredCollapsed: restored.collapsed,
      topStillFolded,
      bottomStillFolded,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!bottomStillFolded) process.exitCode = 1;
    await reopened.close();
    await context.close();
  }
} finally {
  await browser.close();
}
