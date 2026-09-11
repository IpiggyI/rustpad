# 折叠：IME 期间视图稳定，模式切换不丢折叠

Status: needs-triage

2026-09-11 实机：折叠记忆（用户故事 2–4）反复切模式未再复现丢失。输入闪烁（用户故事 1）根因是 Monaco 0.43.0 输入缓冲区坐标混用；加载器已钉到已安装的 0.52.2。浏览器复现检查通过后，报告人在 Windows 小狼毫原机确认闪烁不再出现。下文关于组合期间折叠更新导致闪烁的解释是已否定的旧假设。证据见 [诊断记录](diagnostics/root-cause.md) 与 `issues/03-input-flicker-root-cause-unknown.md`。

## 问题陈述

上一版只挡住了标题输入框的受控回写，以及 Monaco 远程光标的 `deltaDecorations`。正文里的「打字时原有文字闪成别的字、空格或回车后恢复」和「普通模式与块模式来回切、部分已折内容又展开」都还在。

根因不是两套互不相干的皮面问题：

1. **闪烁。** Monaco `FoldingController` 在每次模型内容变化时都会 `triggerFoldingModelChanged`（去抖至少 200ms），随后 `updatePost` 写折叠装饰、`setHiddenAreas` 重映射可见行。中文输入法在候选阶段经常停顿超过 200ms，这段写入会打到正在组合的 native buffer 上。闪出的字来自仍可见的折叠标题行（隐藏区重映射 / 行 DOM 复用）；删掉那个来源再撤回，校验和对不上，下一次换别的区。上一版的 `composing` 守卫只跳过了我们自己的光标装饰，折叠控制器仍在写。
2. **折叠丢失。** Monaco `getMemento()` 在没有折叠区时返回 `undefined`。我们把它收成 `[]`，而 `[]` 被当成「用户全部展开」可以覆盖已保存记录。块编辑器还把读失败的 `undefined` 写成 `[]` 进清单，卸载时只 `persist.cancel()` 不 flush。恢复是一次 `applyMemento`，范围未就绪或校验和暂时对不上就静默无效，随后空读把真折叠写丢。旁路文档 `replaceContent` 可能还在 `buffer` 里，`dispose` 直接 `ws.close()` 会丢掉最后一次折叠写出。

普通模式与块模式仍是两份独立工作区，切换不搬正文或折叠。本票只让各自已持久化的折叠在切走再切回来之后还在，并且输入法组合期间可见正文不再被折叠更新打乱。

## 用户故事

1. 作为 markdown（以及 json / xml 等可折语言）用户，我在已折叠若干标题的文档里用输入法打字，即使最下方的标题是折上的，组合过程中已有正文也不应该闪成折叠标题里的字；空格或回车只结束组合，不负责「把字变回来」。
2. 作为普通模式用户，我折上若干区后多次切到块模式再切回来，这些区仍折着。折叠后立刻切换也不能丢。
3. 作为块模式用户，我折上块内标题后多次切到普通模式再切回来，这些区仍折着。折叠后立刻切换也不能丢。
4. 作为用户，我真的把全部区展开之后，这次清空会被记住，刷新或切模式回来仍是展开。

## 实现决策

- **IME 期间冻结折叠控制器更新，不是只 cancel 一次。** `onDidChangeModelContent` 每次组合按键都会重新 `triggerFoldingModelChanged`，只在 `compositionstart` cancel 调度器会输给候选停顿窗口。组合开始到结束整段内，对该编辑器实例的 `triggerFoldingModelChanged` 改为 no-op；开始时 cancel 并清空 in-flight `foldingRegionPromise` 和 `updateScheduler`；结束时调用原来的 trigger。字段缺失则跳过，不抛。这与现有 `getMemento` / `applyMemento` 同级，钉在 `monaco-editor ^0.52.2`。挂在编辑器上，由已经监听 composition 的 `Rustpad` 接入，不只包 markdown 提供器。
- **未读与清空分开。** 没有 folding model、或 `regions.length === 0`、或 `getMemento()` 为 `undefined` 且没有 regions：读结果是 `undefined`，不得持久化、不得写成 `[]`。只有 `regions.length > 0` 且 `getMemento()` 为 `undefined` 才是真的 `[]`（模型已有可折区，当前没有折上的）。`saveSingleDocFolds` 与块清单写入都遵守这条。`foldMementoForFlush` 在 live 为真 `[]` 时仍返回 `[]`（用户清空）；live 为 `undefined` 时回退 last-good。
- **恢复可重试，但只在恢复会话内。** 优先走 `FoldingController.restoreViewState({ collapsedRegions })`，让 `_restoringViewState` 挡住 `revealCursor` 把刚恢复的区展开。在 `restoring` 为真时订阅折叠模型变化并重试，直到校验和能对上的区已经折上，或一次 `regions.length > 0` 的计算对不上任何区（内容已变，放弃那些区）。恢复结束后必须取消订阅，禁止终身 `onDidChange` 把用户后来展开的区再折回去。
- **块编辑器卸载必须同步 flush last-good**，与普通模式同一语义：去抖可以 cancel，last-good 不能丢。隐藏区域变化时先记下 last-good。
- **旁路文档 dispose 前把 outstanding 与 buffer 发出去**，再关 socket，避免模式切换丢掉最后一次折叠写出。
- **自己的持久化回声不得再 `applyMemento`。** 旁路 `handleSidecarText` 与块 `block.folds` 第二 effect：记录与 last-saved 相等则跳过恢复。

## 非目标

- 普通模式与块模式之间传递折叠或正文。
- 个人视图隔离。
- 给没有 Monaco 折叠范围的语言发明折叠规则。
- 用整份编辑器视图状态（光标 + 视口）代替折叠 memento。
- 引入 Playwright / 浏览器端到端依赖。
- 把 `folding` 选项在组合期间关掉（会拆掉 folding model 并清 hidden areas）。
- 只靠冻结 `setHiddenAreas` 而不挡 `deltaDecorations`。
