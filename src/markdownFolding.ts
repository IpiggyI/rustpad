import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

type Monaco = typeof monaco;

/** Compute folding ranges for ATX headings (`#` ~ `######`), skipping code fences. */
function computeHeadingRanges(
  lines: string[],
): monaco.languages.FoldingRange[] {
  const ranges: monaco.languages.FoldingRange[] = [];
  const stack: { level: number; start: number }[] = [];
  let fenceChar: string | null = null;

  const close = (level: number, endLine: number) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      const open = stack.pop()!;
      if (endLine > open.start) {
        ranges.push({ start: open.start, end: endLine });
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (fenceChar === null) {
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar) {
        fenceChar = null;
      }
      continue;
    }
    if (fenceChar !== null) {
      continue;
    }
    const heading = line.match(/^(#{1,6})\s/);
    if (heading) {
      const level = heading[1].length;
      close(level, i); // fold up to the line before this heading (1-based: i)
      stack.push({ level, start: i + 1 });
    }
  }
  close(0, lines.length);
  return ranges;
}

export function registerMarkdownFolding(m: Monaco) {
  m.languages.registerFoldingRangeProvider("markdown", {
    provideFoldingRanges: (model) =>
      computeHeadingRanges(model.getLinesContent()),
  });
}
