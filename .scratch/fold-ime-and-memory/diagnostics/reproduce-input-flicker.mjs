// 在临时本地服务上执行；依赖与旧版 Monaco 通过环境变量提供。
// 该脚本只向新建的诊断文档写入固定样本，并在浏览器内做临时对照。
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.env.RUSTPAD_DIAG_PLAYWRIGHT, "缺少 RUSTPAD_DIAG_PLAYWRIGHT");
assert.ok(process.env.RUSTPAD_DIAG_OLD_MONACO, "缺少 RUSTPAD_DIAG_OLD_MONACO");
const { chromium } = await import(
  pathToFileURL(process.env.RUSTPAD_DIAG_PLAYWRIGHT).href
);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const installedVersion = JSON.parse(
  await readFile(join(repo, "node_modules/monaco-editor/package.json"), "utf8"),
).version;
const artifacts = await mkdtemp(join(tmpdir(), "rustpad-input-evidence-"));
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const modes = process.env.RUSTPAD_DIAG_APPLICATION_ONLY
    ? ["application"]
    : [
        "baseline",
        "coordinate-correction",
        "0.52.2",
        "baseline-repeat",
        "application",
      ];
  for (const mode of modes) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1.5,
    });
    const requestedVersions = new Set();
    const base =
      mode === "0.52.2"
        ? join(repo, "node_modules/monaco-editor")
        : process.env.RUSTPAD_DIAG_OLD_MONACO;
    await page.route(
      "https://cdn.jsdelivr.net/npm/monaco-editor@*/min/vs/**",
      async (route) => {
        const version = route
          .request()
          .url()
          .match(/monaco-editor@([^/]+)/)[1];
        requestedVersions.add(version);
        const resourceBase =
          mode === "application"
            ? version === installedVersion
              ? join(repo, "node_modules/monaco-editor")
              : (assert.equal(version, "0.43.0"),
                process.env.RUSTPAD_DIAG_OLD_MONACO)
            : base;
        await route.fulfill({
          path:
            resourceBase +
            "/min/vs/" +
            new URL(route.request().url()).pathname.split("/min/vs/")[1],
        });
      },
    );
    await page.goto("http://127.0.0.1:5173/#causal-" + Date.now());
    await page.waitForFunction(
      () => window.monaco?.editor.getEditors().length > 0,
    );
    await page.waitForTimeout(400);
    await page.evaluate((mode) => {
      window.ed = monaco.editor.getEditors()[0];
      monaco.editor.setModelLanguage(ed.getModel(), "markdown");
      if (mode === "application") return;
      const vm = ed._getViewModel(),
        original = vm.modifyPosition;
      window.trace = [];
      vm.modifyPosition = function (position, offset) {
        const returned = original.call(this, position, offset);
        const result =
          mode === "coordinate-correction"
            ? this.coordinatesConverter.convertModelPositionToViewPosition(
                returned,
              )
            : returned;
        window.trace.push({ position, offset, returned, result });
        return result;
      };
    }, mode);
    const cdp = await page.context().newCDPSession(page);
    for (const [total, target, folds] of [
      [20, 12, [1]],
      [30, 16, [1, 21]],
    ]) {
      await page.evaluate((total) => {
        ed.setValue(
          Array.from({ length: total }, (_, i) =>
            i % 10 === 0
              ? `# HEADER ${i + 1}`
              : `ROW ${i + 1} ` + "x".repeat(150) + ` END ${i + 1}`,
          ).join("\n"),
        );
      }, total);
      await page.waitForTimeout(400);
      for (const line of folds)
        await page.evaluate(async (line) => {
          ed.setPosition({ lineNumber: line, column: 1 });
          await ed.getAction("editor.fold").run();
        }, line);
      await page.evaluate((target) => {
        ed.setPosition({ lineNumber: target, column: 16 });
        ed.revealPositionInCenter(ed.getPosition());
        ed.focus();
        window.hiddenCount = 0;
        window.sub = ed.onDidChangeHiddenAreas(() => window.hiddenCount++);
        window.before = ed.getValue();
      }, target);
      await cdp.send("Input.imeSetComposition", {
        text: "nihao",
        selectionStart: 5,
        selectionEnd: 5,
      });
      await page.waitForTimeout(100);
      const result = await page.evaluate(() => {
        const t = document.querySelector("textarea.inputarea"),
          o = t.selectionStart,
          p = ed.getPosition(),
          prefix = t.value.slice(t.value.lastIndexOf("\n", o - 1) + 1, o),
          expectedPrefix = ed
            .getModel()
            .getLineContent(p.lineNumber)
            .slice(0, p.column - 1),
          old = window.before.split("\n"),
          cur = ed.getValue().split("\n");
        return {
          position: p,
          prefix,
          expectedPrefix,
          correct: expectedPrefix.endsWith(prefix),
          scrollTop: t.scrollTop,
          expectedScrollTop:
            (t.value.slice(0, o).split("\n").length - 1) *
            parseFloat(getComputedStyle(t).lineHeight),
          hiddenChanges: window.hiddenCount,
          otherLinesUnchanged: old.every(
            (v, i) => i === p.lineNumber - 1 || cur[i] === v,
          ),
          viewLineDOM: [
            ...document.querySelectorAll(".view-lines .view-line"),
          ].some(
            (e) =>
              e.textContent.replaceAll("\u00a0", " ") ===
              ed.getModel().getLineContent(p.lineNumber),
          ),
          trace: window.trace?.slice(-2),
        };
      });
      console.log(JSON.stringify({ mode, total, target, ...result }));
      if (mode === "baseline")
        await page.screenshot({
          path: join(artifacts, `before-${target}.png`),
        });
      assert.equal(result.correct, !mode.startsWith("baseline"));
      assert.equal(result.scrollTop, result.expectedScrollTop);
      assert.equal(result.hiddenChanges, 0);
      assert.equal(result.otherLinesUnchanged, true);
      assert.equal(result.viewLineDOM, true);
      await cdp.send("Input.insertText", { text: "你好" });
      await page.waitForTimeout(80);
      assert.equal(
        await page.evaluate(
          () => !!document.querySelector("textarea.ime-input"),
        ),
        false,
      );
      if (mode === "baseline")
        await page.screenshot({ path: join(artifacts, `after-${target}.png`) });
      await page.evaluate(() => window.sub.dispose());
    }
    if (mode === "application") {
      assert.deepEqual([...requestedVersions], [installedVersion]);
      console.log("实际应用加载版本：", [...requestedVersions]);
    }
    await page.close();
  }
  console.log(
    "验证通过：全部所选样本符合预期，实际应用的输入缓冲区与正文一致。",
  );
  console.log("截图目录：", artifacts);
} finally {
  await browser.close();
}
