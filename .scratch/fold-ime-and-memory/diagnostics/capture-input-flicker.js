// 在 Chrome 开发者工具的控制台运行。复现后运行：
// copy(rustpadInputDiag.report())
// 报告会停止采样；再次运行本文件可重新开始。报告不包含正文或输入内容。
(() => {
  window.rustpadInputDiag?.stop();
  const editors = window.monaco?.editor?.getEditors?.();
  if (!editors?.length) throw new Error("未找到 Monaco 编辑器");
  const ed = editors.find((item) => item.hasTextFocus()) ?? editors[0];
  const root = ed.getDomNode();
  const records = [];
  const anomalies = [];
  const disposables = [];
  const started = performance.now();
  let frame;
  let stopped = false;
  let baseline;
  let baselineSelection;
  let previous;
  let frameCount = 0;
  let hiddenAreaChanges = 0;
  const hash = (text) => {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) {
      value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    }
    return (value >>> 0).toString(16);
  };
  const record = (entry) => {
    records.push({ ms: Math.round(performance.now() - started), ...entry });
    if (records.length > 600) records.shift();
  };
  const onComposition = (event) => {
    if (event.type === "compositionstart") {
      baseline = ed.getModel()?.getLinesContent();
      baselineSelection = ed.getSelection();
    }
    record({ event: event.type, inputLength: event.data?.length ?? 0 });
  };
  for (const name of ["compositionstart", "compositionupdate", "compositionend"]) {
    root.addEventListener(name, onComposition, true);
    disposables.push(() => root.removeEventListener(name, onComposition, true));
  }
  const hiddenListener = ed.onDidChangeHiddenAreas(() => {
    hiddenAreaChanges++;
    record({ event: "hiddenAreas", count: hiddenAreaChanges });
  });
  disposables.push(() => hiddenListener.dispose());
  const sample = () => {
    if (stopped) return;
    frameCount++;
    const textarea = root.querySelector("textarea.inputarea");
    if (textarea?.classList.contains("ime-input")) {
      const style = getComputedStyle(textarea);
      const lineHeight = parseFloat(style.lineHeight);
      const lines = textarea.value.split("\n");
      const selectedLine = textarea.value.slice(0, textarea.selectionStart).split("\n").length - 1;
      const displayedLine = Math.round(textarea.scrollTop / lineHeight);
      const model = ed.getModel();
      const modelLines = model?.getLinesContent() ?? [];
      const displayed = lines[displayedLine];
      const position = ed.getPosition();
      const sameLineEdit = baselineSelection &&
        baselineSelection.startLineNumber === baselineSelection.endLineNumber &&
        baselineSelection.startLineNumber === position?.lineNumber &&
        baseline?.length === modelLines.length;
      const outsideEditedLineChanged = sameLineEdit
        ? baseline.some((line, i) => i !== position.lineNumber - 1 && line !== modelLines[i])
        : null;
      const snapshot = {
        event: "frame",
        modelVersion: model?.getVersionId(),
        position,
        selectedLine,
        displayedLine,
        scrollTop: textarea.scrollTop,
        expectedScrollTop: selectedLine * lineHeight,
        lineHeight,
        textareaHeight: textarea.clientHeight,
        textareaLines: lines.length,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        displayedHash: displayed === undefined ? null : hash(displayed),
        selectedHash: hash(lines[selectedLine] ?? ""),
        displayedMatchesModelLine: displayed === undefined ? 0 : modelLines.indexOf(displayed) + 1,
        outsideEditedLineChanged,
        hiddenAreaChanges,
        textareaTop: textarea.getBoundingClientRect().top,
      };
      const signature = JSON.stringify(snapshot);
      if (signature !== previous) {
        previous = signature;
        record(snapshot);
        if (selectedLine !== displayedLine || outsideEditedLineChanged) {
          anomalies.push(records.slice(-15));
          if (anomalies.length > 10) anomalies.shift();
        }
      }
    }
    frame = requestAnimationFrame(sample);
  };
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    disposables.splice(0).forEach((dispose) => dispose());
    baseline = undefined;
    baselineSelection = undefined;
  };
  window.rustpadInputDiag = {
    stop,
    report() {
      stop();
      return JSON.stringify({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        devicePixelRatio,
        monacoScripts: [...document.scripts].map((script) => script.src)
          .filter((src) => /monaco-editor@[^/]+\/min\/vs\/(loader|editor\/editor.main)\.js/.test(src))
          .map((src) => src.match(/monaco-editor@([^/]+)/)?.[1]),
        frameCount,
        hiddenAreaChanges,
        records,
        anomalies,
      }, null, 2);
    },
  };
  frame = requestAnimationFrame(sample);
  console.info("输入诊断已开始。复现后运行 copy(rustpadInputDiag.report()) 并回传结果。");
})();
