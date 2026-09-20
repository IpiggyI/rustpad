/** Real Monaco regression checks. Prerequisites match headingEnter.browser.mjs. */
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

async function open(context, url) {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.monaco?.editor.getEditors().length);
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.ed = monaco.editor.getEditors()[0];
  });
  return page;
}

async function prepare(page, text, line) {
  await page.evaluate(
    async ({ text, line }) => {
      await ed.getAction("editor.unfoldAll").run();
      ed.setValue(text);
      await ed.getContribution("editor.contrib.folding").getFoldingModel();
      ed.setPosition({
        lineNumber: line,
        column: ed.getModel().getLineMaxColumn(line),
      });
      ed.focus();
      await ed.getAction("editor.fold").run();
    },
    { text, line },
  );
  await page.waitForTimeout(700);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const model = ed.getModel();
    const folding = ed.getContribution("editor.contrib.folding").foldingModel;
    return {
      text: ed.getValue(),
      hidden: ed
        ._getViewModel()
        .getHiddenAreas()
        .map((r) => [r.startLineNumber, r.endLineNumber]),
      ranges: Array.from({ length: folding.regions.length }, (_, i) => ({
        start: folding.regions.getStartLineNumber(i),
        end: folding.regions.getEndLineNumber(i),
        collapsed: folding.regions.isCollapsed(i),
        source: folding.regions.getSource(i),
        line: model.getLineContent(folding.regions.getStartLineNumber(i)),
        heading: /^#{1,6}\s/.test(
          model.getLineContent(folding.regions.getStartLineNumber(i)),
        ),
      })),
      visible: [...ed.getDomNode().querySelectorAll(".view-line")].map((el) =>
        el.textContent.replace(/\u00a0/g, " "),
      ),
    };
  });
}

async function splitHeading(page) {
  await prepare(page, "## 原折叠\nbody\n## Next\nend", 1);
  await page.keyboard.insertText("换行测试");
  await page.waitForTimeout(500);
  await page.evaluate(() => ed.setPosition({ lineNumber: 1, column: 7 }));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const actual = await snapshot(page);
  assert.equal(actual.text, "## 原折叠\n换行测试\nbody\n## Next\nend");
  assert.equal(actual.visible.includes("换行测试"), true);
  assert.equal(
    actual.ranges.every((r) => r.heading),
    true,
    JSON.stringify(actual.ranges),
  );
  assert.deepEqual(actual.hidden, []);
  await page.keyboard.press("Control+z");
  assert.equal(
    (await snapshot(page)).text,
    "## 原折叠换行测试\nbody\n## Next\nend",
  );
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(700);
  assert.equal(
    (await snapshot(page)).ranges.every((r) => r.heading),
    true,
  );
}

async function prependAndReopen(page, context, url) {
  await prepare(page, "visible\n## Folded\nbody", 2);
  assert.deepEqual((await snapshot(page)).hidden, [[3, 3]]);
  await page.evaluate(() => {
    ed.setPosition({ lineNumber: 1, column: 1 });
    ed.focus();
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  assert.deepEqual((await snapshot(page)).hidden, [[4, 4]]);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(700);
  assert.deepEqual((await snapshot(page)).hidden, [[3, 3]]);
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(700);
  assert.deepEqual((await snapshot(page)).hidden, [[4, 4]]);
  await page.close();
  const reopened = await open(context, url);
  await reopened.waitForTimeout(800);
  assert.deepEqual((await snapshot(reopened)).hidden, [[4, 4]]);
  await reopened.close();
}

async function boundaryAndReopen(page, context, url) {
  await prepare(page, "## Folded\nfirst\nlast\n## Tail\nend", 1);
  await page.evaluate(() =>
    ed.executeEdits("test", [
      { range: new monaco.Range(3, 1, 3, 1), text: "changed " },
    ]),
  );
  await page.waitForTimeout(800);
  assert.deepEqual((await snapshot(page)).hidden, [[2, 3]]);
  await page.close();
  const fresh = await browser.newContext();
  const reopened = await open(fresh, url);
  await reopened.waitForTimeout(800);
  assert.deepEqual((await snapshot(reopened)).hidden, [[2, 3]]);
  await fresh.close();
}

async function manualFold(page) {
  await prepare(page, "## Heading\nfirst\nsecond\nthird\n## Tail\nend", 1);
  await page.evaluate(async () => {
    await ed.getAction("editor.unfoldAll").run();
    ed.setSelection(new monaco.Selection(2, 1, 4, 1));
    await ed.getAction("editor.createFoldingRangeFromSelection").run();
  });
  await page.waitForTimeout(700);
  const actual = await snapshot(page);
  assert.equal(
    actual.ranges.some((r) => r.source === 1 && r.start === 2 && r.collapsed),
    true,
  );
}

async function nestedAndClear(page, context, url) {
  await prepare(page, "# Parent\nbody\n## Child\nchild\n# Tail\nend", 1);
  await page.evaluate(async () => {
    const folding = await ed
      .getContribution("editor.contrib.folding")
      .getFoldingModel();
    folding.toggleCollapseState([folding.getRegionAtLine(3)]);
  });
  await page.waitForTimeout(700);
  assert.equal(
    (await snapshot(page)).ranges.filter((r) => r.collapsed).length,
    2,
  );
  await page.close();
  const reopened = await open(context, url);
  await reopened.waitForTimeout(800);
  assert.equal(
    (await snapshot(reopened)).ranges.filter((r) => r.collapsed).length,
    2,
  );
  await reopened.evaluate(() => ed.getAction("editor.unfoldAll").run());
  await reopened.waitForTimeout(700);
  await reopened.close();
  const cleared = await open(context, url);
  await cleared.waitForTimeout(800);
  assert.deepEqual((await snapshot(cleared)).hidden, []);
  await cleared.close();
}

async function imeAndReopen(page, context, url) {
  await prepare(page, "visible\n## Folded\nbody", 2);
  await page.evaluate(() => {
    ed.setPosition({ lineNumber: 1, column: 1 });
    ed.focus();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "新增",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await page.waitForTimeout(300);
  await cdp.send("Input.insertText", { text: "新增" });
  await cdp.detach();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  assert.equal((await snapshot(page)).text, "新增\nvisible\n## Folded\nbody");
  assert.deepEqual((await snapshot(page)).hidden, [[4, 4]]);
  await page.close();
  const reopened = await open(context, url);
  await reopened.waitForTimeout(800);
  assert.deepEqual((await snapshot(reopened)).hidden, [[4, 4]]);
  await reopened.close();
}

async function middleInsertAndReopen(page, context, url) {
  await page.evaluate(async () => {
    await ed.getAction("editor.unfoldAll").run();
    ed.setValue("## Top\ntop body\n## Mid\nmid body\n## Bottom\nbottom body");
    await ed.getContribution("editor.contrib.folding").getFoldingModel();
    ed.setPosition({ lineNumber: 1, column: 1 });
    await ed.getAction("editor.fold").run();
    ed.setPosition({ lineNumber: 5, column: 1 });
    await ed.getAction("editor.fold").run();
  });
  await page.waitForTimeout(700);
  assert.deepEqual((await snapshot(page)).hidden, [
    [2, 2],
    [6, 6],
  ]);
  await page.evaluate(() => {
    ed.setPosition({
      lineNumber: 4,
      column: ed.getModel().getLineMaxColumn(4),
    });
    ed.focus();
  });
  for (const text of ["one", "two", "three"]) {
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(text);
  }
  const live = () =>
    page.evaluate(
      () =>
        ed
          .getContribution("editor.contrib.folding")
          .foldingModel.getMemento() ?? [],
    );
  const saved = async () => {
    const hash = new URL(url).hash.slice(1);
    const recordId = hash.startsWith("page:")
      ? `${hash}:manifest`
      : `folds:${hash}`;
    const value = JSON.parse(
      await (await fetch(`${base}/api/text/${recordId}`)).text(),
    );
    return hash.startsWith("page:") ? value.blocks[0].folds : value.markdown;
  };
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (JSON.stringify(await live()) === JSON.stringify(await saved())) break;
    await page.waitForTimeout(50);
  }
  assert.equal(
    JSON.stringify(await live()),
    JSON.stringify(await saved()),
    "the moved fold record must reach the server before close",
  );
  await page.close();
  const reopened = await open(context, url);
  await reopened.waitForTimeout(1000);
  const actual = await snapshot(reopened);
  assert.equal(
    actual.ranges.some((r) => r.collapsed && r.line.startsWith("## Top")),
    true,
    JSON.stringify(actual.ranges),
  );
  assert.equal(
    actual.ranges.some((r) => r.collapsed && r.line.startsWith("## Bottom")),
    true,
    "the heading below the insert must stay folded after close",
  );
  await reopened.close();
}

async function remoteEdit(page, context, url) {
  await prepare(page, "## 原折叠\nbody\n## Next\nend", 1);
  const peerContext = await browser.newContext();
  const peer = await open(peerContext, url);
  await peer.waitForTimeout(800);
  await peer.evaluate(() =>
    ed.executeEdits("test", [
      { range: new monaco.Range(1, 7, 1, 7), text: "换行测试" },
    ]),
  );
  await page.waitForFunction(() =>
    ed.getValue().startsWith("## 原折叠换行测试"),
  );
  await page.waitForTimeout(700);
  await peer.evaluate(() =>
    ed.executeEdits("test", [
      { range: new monaco.Range(1, 7, 1, 7), text: "\n" },
    ]),
  );
  await page.waitForFunction(() =>
    ed.getValue().startsWith("## 原折叠\n换行测试"),
  );
  await page.waitForTimeout(900);
  assert.equal(
    (await snapshot(page)).ranges.every((r) => r.heading),
    true,
  );
  await peerContext.close();
}

const cases = {
  prepend: prependAndReopen,
  "split-heading": splitHeading,
  boundary: boundaryAndReopen,
  manual: manualFold,
  "nested-clear": nestedAndClear,
  ime: imeAndReopen,
  remote: remoteEdit,
  "middle-insert": middleInsertAndReopen,
};

try {
  for (const mode of ["single", "block"]) {
    for (const name of Object.keys(cases).filter(
      (name) => !process.env.FOLD_CASE || process.env.FOLD_CASE === name,
    )) {
      const context = await browser.newContext();
      const url = `${base}/#${mode === "block" ? "page:" : ""}fold-memory-${mode}-${name}-${Date.now()}`;
      const page = await open(context, url);
      await page
        .locator(mode === "block" ? "[data-block-panel] select" : "select")
        .first()
        .selectOption("markdown");
      await cases[name](page, context, url);
      console.log(`PASS ${mode}: ${name}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
