/**
 * Prerequisites for `npm run test:browser`:
 * - Run `npm ci` to install playwright-core. PLAYWRIGHT_MODULE may point to an
 *   alternate Playwright module specifier or absolute module path.
 * - Start the dev server with `npm run dev`. RUSTPAD_URL selects its URL
 *   (default: http://127.0.0.1:5173).
 * - Start the backend with `PORT=3030 cargo run -p rustpad-server` on
 *   127.0.0.1:3030, the /api proxy target in vite.config.ts. RUSTPAD_URL selects
 *   the frontend; it does not override that backend target.
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

async function open(context, url) {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.monaco?.editor.getEditors().length);
  assert.match(
    await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => name.includes("/min/vs/editor/editor.main.js")),
    ),
    /monaco-editor@0\.52\.2\//,
  );
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.ed = window.monaco.editor.getEditors()[0];
  });
  return page;
}

async function snapshot(page) {
  return page.evaluate(() => ({
    text: ed.getValue(),
    position: { ...ed.getPosition() },
    hidden: ed
      ._getViewModel()
      .getHiddenAreas()
      .map((r) => [r.startLineNumber, r.endLineNumber]),
    // What the user actually sees. The view keeps its own line mapping, and it
    // can drop the new heading while the hidden ranges still read correctly.
    visible: [...ed.getDomNode().querySelectorAll(".view-line")]
      .map((el) => ({ top: parseInt(el.style.top, 10), text: el.textContent }))
      .sort((a, b) => a.top - b.top)
      // Monaco renders a trailing space as a non-breaking space.
      .map((line) => line.text.replace(/\u00a0/g, " ")),
  }));
}

async function prepare(page, text, end, collapsed = true) {
  await page.evaluate(
    async ({ text, collapsed }) => {
      await ed.getAction("editor.unfoldAll").run();
      ed.setValue(text);
      ed.setPosition({ lineNumber: 1, column: text.split("\n")[0].length + 1 });
      ed.focus();
      await ed.getContribution("editor.contrib.folding").getFoldingModel();
      if (collapsed) await ed.getAction("editor.fold").run();
    },
    { text, collapsed },
  );
  await page.waitForTimeout(350);
  assert.deepEqual((await snapshot(page)).hidden, collapsed ? [[2, end]] : []);
  return snapshot(page);
}

/**
 * Fold, then change the document while Monaco's debounced folding computation is
 * held back, so its FoldingRegions line numbers are provably out of date when
 * Enter arrives. Returns the stale and live spans of the folded region.
 */
async function holdFoldingThenEdit(page, { text, foldLine, edit, caret }) {
  await page.evaluate(
    async ({ text, foldLine }) => {
      await ed.getAction("editor.unfoldAll").run();
      ed.setValue(text);
      await ed.getContribution("editor.contrib.folding").getFoldingModel();
      ed.setPosition({ lineNumber: foldLine, column: 1 });
      await ed.getAction("editor.fold").run();
    },
    { text, foldLine },
  );
  await page.waitForTimeout(350);
  return page.evaluate(
    ({ edit, caret }) => {
      const contribution = ed.getContribution("editor.contrib.folding");
      const held = contribution.triggerFoldingModelChanged;
      contribution.updateScheduler?.cancel?.();
      contribution.foldingRegionPromise?.cancel?.();
      contribution.triggerFoldingModelChanged = () => undefined;
      window.releaseFolding = () => {
        contribution.triggerFoldingModelChanged = held;
        held.call(contribution);
        window.releaseFolding = undefined;
      };
      ed.executeEdits("test.staleFolding", [
        { range: new monaco.Range(...edit.range), text: edit.text },
      ]);
      ed.setPosition(caret);
      ed.focus();
      const folding = contribution.foldingModel;
      const index = (() => {
        for (let i = 0; i < folding.regions.length; i++)
          if (folding.regions.isCollapsed(i)) return i;
        return -1;
      })();
      const live = ed
        .getModel()
        .getDecorationRange(folding._editorDecorationIds[index]);
      return {
        stale: [
          folding.regions.getStartLineNumber(index),
          folding.regions.getEndLineNumber(index),
        ],
        live: [live.startLineNumber, live.endLineNumber],
      };
    },
    { edit, caret },
  );
}

async function exclusion(page, name, baseline) {
  await prepare(page, "## 1\n111", 2, name !== "expanded");
  await page.evaluate(
    async ({ name, baseline }) => {
      if (baseline) {
        const key = ed.createContextKey("rustpadHeadingEnter", false);
        window.disableHeading = ed.onKeyDown(() => key.set(false));
      }
      if (name === "mid-line") ed.setPosition({ lineNumber: 1, column: 3 });
      if (name === "selection")
        ed.setSelection(new monaco.Selection(1, 3, 1, 5));
      if (name === "multi-cursor")
        ed.setSelections([
          new monaco.Selection(1, 5, 1, 5),
          new monaco.Selection(1, 2, 1, 2),
        ]);
      if (name === "other-language")
        monaco.editor.setModelLanguage(ed.getModel(), "plaintext");
      if (name === "composition") {
        window.compositionStarted = false;
        window.compositionListener = ed.onDidCompositionStart(() => {
          window.compositionStarted = true;
        });
      }
      if (name === "find") await ed.getAction("actions.find").run();
      if (name === "snippet") {
        ed.setSelection(new monaco.Selection(1, 1, 1, 5));
        ed.getContribution("snippetController2").insert("${1:## 1}$0");
        ed.setPosition({ lineNumber: 1, column: 5 });
      }
      if (name === "suggestion") {
        window.completions = monaco.languages.registerCompletionItemProvider(
          "markdown",
          {
            provideCompletionItems: () => ({
              suggestions: [
                {
                  label: "Heading suggestion",
                  kind: monaco.languages.CompletionItemKind.Text,
                  insertText: "Accepted",
                  range: new monaco.Range(1, 4, 1, 5),
                },
              ],
            }),
          },
        );
        await ed.getAction("editor.action.triggerSuggest").run();
      }
    },
    { name, baseline },
  );
  if (name === "suggestion")
    await page.locator(".suggest-widget.visible").waitFor();
  if (name === "snippet")
    assert.equal(
      await page.evaluate(() =>
        ed._contextKeyService.getContextKeyValue("inSnippetMode"),
      ),
      true,
    );
  if (name === "composition") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "候选",
      selectionStart: 2,
      selectionEnd: 2,
    });
    assert.equal(await page.evaluate(() => window.compositionStarted), true);
    await cdp.detach();
  }
  await page.keyboard.press(name.endsWith("+Enter") ? name : "Enter");
  await page.waitForTimeout(400);
  const result = await snapshot(page);
  if (name === "composition") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.insertText", { text: "候选" });
    await cdp.detach();
  }
  await page.evaluate(async (name) => {
    window.disableHeading?.dispose();
    window.disableHeading = undefined;
    window.completions?.dispose();
    window.completions = undefined;
    window.compositionListener?.dispose();
    if (name === "other-language")
      monaco.editor.setModelLanguage(ed.getModel(), "markdown");
    if (name === "snippet") ed.getContribution("snippetController2").cancel();
  }, name);
  await page.keyboard.press("Escape");
  return result;
}

try {
  for (const mode of ["single", "block"]) {
    const context = await browser.newContext();
    const url = `${base}/#${mode === "block" ? "page:" : ""}heading-enter-${mode}-${Date.now()}`;
    const page = await open(context, url);
    await page
      .locator(mode === "block" ? "[data-block-panel] select" : "select")
      .first()
      .selectOption("markdown");
    const peer = await open(context, url);
    for (const scenario of [
      {
        name: "empty EOF",
        before: "###### Six\n",
        after: "###### Six\n\n###### ",
        end: 2,
        column: 8,
        visible: ["###### Six", "###### "],
      },
      {
        name: "EOF",
        before: "## 1\n111",
        after: "## 1\n111\n## ",
        end: 2,
        column: 4,
        visible: ["## 1", "## "],
      },
      {
        name: "same-level",
        before: "## Original\nbody\n## Next\nnext body",
        after: "## Original\nbody\n## \n## Next\nnext body",
        end: 2,
        column: 4,
        visible: ["## Original", "## ", "## Next", "next body"],
      },
      {
        name: "higher-level",
        before: "### Original\nbody\n# Next\nnext body",
        after: "### Original\nbody\n### \n# Next\nnext body",
        end: 2,
        column: 5,
        visible: ["### Original", "### ", "# Next", "next body"],
      },
      {
        name: "nested",
        before: "# Root\nbody\n## Child\nchild body\n### Leaf\nleaf body",
        after: "# Root\nbody\n## Child\nchild body\n### Leaf\nleaf body\n# ",
        end: 6,
        column: 3,
        visible: ["# Root", "# "],
      },
    ]) {
      await prepare(page, scenario.before, scenario.end);
      await peer.waitForFunction(
        (text) => ed.getValue() === text,
        scenario.before,
      );
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      assert.deepEqual(await snapshot(page), {
        text: scenario.after,
        position: { lineNumber: scenario.end + 1, column: scenario.column },
        hidden: [[2, scenario.end]],
        visible: scenario.visible,
      });
      await peer.waitForFunction(
        (text) => ed.getValue() === text,
        scenario.after,
      );
      await page.keyboard.press("Control+z");
      assert.equal((await snapshot(page)).text, scenario.before);
      await peer.waitForFunction(
        (text) => ed.getValue() === text,
        scenario.before,
      );
      await page.keyboard.press("Control+y");
      assert.equal((await snapshot(page)).text, scenario.after);
      await peer.waitForFunction(
        (text) => ed.getValue() === text,
        scenario.after,
      );
      console.log(
        `PASS ${mode}: ${scenario.name}, text/caret/hidden ranges/undo/redo/peer`,
      );
    }
    for (const scenario of [
      {
        name: "stale folding, line added above the fold",
        before: "intro\n## A\naaa\n## B\nbbb",
        foldLine: 2,
        edit: { range: [1, 6, 1, 6], text: "\nmore" },
        caret: { lineNumber: 3, column: 5 },
        after: "intro\nmore\n## A\naaa\n## \n## B\nbbb",
        position: { lineNumber: 5, column: 4 },
        hidden: [[4, 4]],
      },
      {
        name: "stale folding, line added inside the fold",
        before: "## A\naaa\n## B\nbbb",
        foldLine: 1,
        edit: { range: [2, 4, 2, 4], text: "\nzzz" },
        caret: { lineNumber: 1, column: 5 },
        after: "## A\naaa\nzzz\n## \n## B\nbbb",
        position: { lineNumber: 4, column: 4 },
        hidden: [[2, 3]],
      },
    ]) {
      const spans = await holdFoldingThenEdit(page, {
        text: scenario.before,
        foldLine: scenario.foldLine,
        edit: scenario.edit,
        caret: scenario.caret,
      });
      assert.notDeepEqual(spans.stale, spans.live, scenario.name);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const held = await snapshot(page);
      assert.deepEqual(
        { text: held.text, position: held.position },
        { text: scenario.after, position: scenario.position },
        scenario.name,
      );
      const caretLine = held.position.lineNumber;
      assert.equal(
        held.hidden.some(
          ([start, end]) => caretLine >= start && end >= caretLine,
        ),
        false,
        `${scenario.name}: the new heading is hidden by the fold above it`,
      );
      assert.equal(
        held.visible.includes(scenario.after.split("\n")[caretLine - 1]),
        true,
        `${scenario.name}: the new heading is missing from the view`,
      );
      await page.evaluate(() => window.releaseFolding?.());
      await page.waitForTimeout(400);
      assert.deepEqual((await snapshot(page)).hidden, scenario.hidden);
      await peer.waitForFunction(
        (text) => ed.getValue() === text,
        scenario.after,
      );
      console.log(
        `PASS ${mode}: ${scenario.name}, text/caret/hidden ranges/peer`,
      );
    }
    if (mode === "block") {
      // A collapsed span that no longer starts a heading must not reach the
      // saved record: monaco carries it forward as a recovered region, which
      // draws a folding arrow on a plain line on every later load.
      const planted = await page.evaluate(async () => {
        await ed.getAction("editor.unfoldAll").run();
        ed.setValue("## A\nplain\nmore\n## B\nbbb");
        const folding = await ed
          .getContribution("editor.contrib.folding")
          .getFoldingModel();
        folding.applyMemento([
          {
            startLineNumber: 2,
            endLineNumber: 3,
            isCollapsed: true,
            source: 0,
          },
        ]);
        return (folding.getMemento() ?? []).map(
          (range) => range.startLineNumber,
        );
      });
      const regionStarts = (target) =>
        target.evaluate(() => {
          const folding = ed.getContribution(
            "editor.contrib.folding",
          ).foldingModel;
          const starts = [];
          for (let i = 0; folding && i < folding.regions.length; i++) {
            if (folding.regions.isCollapsed(i))
              starts.push(folding.regions.getStartLineNumber(i));
          }
          return starts;
        });
      assert.deepEqual(planted, [2], "the stale span was not planted");
      await page.evaluate(async () => {
        ed.setPosition({ lineNumber: 1, column: 1 });
        await ed.getAction("editor.fold").run();
      });
      await page.waitForTimeout(900);
      const reopened = await open(context, url);
      await reopened.waitForFunction(() => ed.getValue().startsWith("## A"));
      await reopened.waitForTimeout(900);
      assert.deepEqual(
        await regionStarts(reopened),
        [1],
        "a folding arrow on a plain line survived into the saved record",
      );
      await reopened.close();
      console.log(
        `PASS ${mode}: a span on a plain line is dropped from the saved record`,
      );
    }
    for (const name of [
      "expanded",
      "mid-line",
      "selection",
      "multi-cursor",
      "other-language",
      "composition",
      "Shift+Enter",
      "Control+Enter",
      "Alt+Enter",
      "Meta+Enter",
      "find",
      "snippet",
      "suggestion",
    ]) {
      const expected = await exclusion(page, name, true);
      assert.deepEqual(await exclusion(page, name, false), expected, name);
      console.log(`PASS ${mode}: ${name} matches default Enter`);
    }
    await prepare(page, "## 1\n111", 2);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    assert.deepEqual(await snapshot(page), {
      text: "## 1\n111\n## ",
      position: { lineNumber: 3, column: 4 },
      hidden: [[2, 2]],
      visible: ["## 1", "## "],
    });
    console.log(`PASS ${mode}: plain Enter after composition ends`);
    await context.close();
  }
} finally {
  await browser.close();
}
