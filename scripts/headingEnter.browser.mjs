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
      },
      {
        name: "EOF",
        before: "## 1\n111",
        after: "## 1\n111\n## ",
        end: 2,
        column: 4,
      },
      {
        name: "same-level",
        before: "## Original\nbody\n## Next\nnext body",
        after: "## Original\nbody\n## \n## Next\nnext body",
        end: 2,
        column: 4,
      },
      {
        name: "higher-level",
        before: "### Original\nbody\n# Next\nnext body",
        after: "### Original\nbody\n### \n# Next\nnext body",
        end: 2,
        column: 5,
      },
      {
        name: "nested",
        before: "# Root\nbody\n## Child\nchild body\n### Leaf\nleaf body",
        after: "# Root\nbody\n## Child\nchild body\n### Leaf\nleaf body\n# ",
        end: 6,
        column: 3,
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
    });
    console.log(`PASS ${mode}: plain Enter after composition ends`);
    await context.close();
  }
} finally {
  await browser.close();
}
