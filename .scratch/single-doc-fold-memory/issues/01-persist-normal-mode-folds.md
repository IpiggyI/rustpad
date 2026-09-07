# 01: 普通模式折叠记录写入本地存储并在重挂载后恢复

**What to build:**
普通模式里折叠的 markdown 标题，切到块模式再切回来仍然折叠；同一台设备刷新后也仍然折叠。折叠后立刻点「Open Block Workspace」也不能丢。完整背景见同目录 `spec.md`。

折叠记录**原样存放 Monaco 的折叠 memento**，读写走折叠贡献，不走整份编辑器视图状态。落点是 `localStorage` 键 `single-doc:folds:${id}`，不写块清单、不改服务端。

已核实的约束：

- `App.tsx` 切换模式会卸载 `SingleDocView`；块模式能保住折叠是因为写了块清单，不是因为编辑器还活着。
- 今日 `SingleDocView` 不调用 `readFoldRecord` / `restoreFoldRecord`，也没有 `onReady`。
- 语言初始值是 `plaintext`，markdown 折叠提供器只对 `markdown` 生效；正文进模型后立刻恢复会静默无效。
- 块编辑器去抖写入在 effect cleanup 里 `persist.cancel()`。普通模式的卸载路径必须同步 `getMemento` + `setItem`，不能把刚折上的记录 cancel 掉。

**Blocked by:** 无

**Status:** ready-for-human

- [x] 按文档 id 读写普通模式折叠记录；键为 `single-doc:folds:${id}`；损坏或读失败视为没有记录，不抛到编辑流程
- [x] 写入由隐藏区域变化触发；去抖；与上次已保存记录比对，只在 `doesFoldRecordDiffer` 为真时写
- [x] 恢复在正文已进模型、编辑器语言已是文档语言、折叠模型就绪之后执行；对 markdown 文档即语言为 `markdown`
- [x] 恢复结束前不持久化；读不到的 memento（`undefined`）不得把已保存记录写成空；恢复结束后用户全部展开（`[]`）会写入
- [x] 卸载时同步写出当前 memento，折叠后立刻切换模式仍能保住
- [x] 不把普通模式折叠写入块清单，不改 `BlockPageView` 的模式切换语义
- [x] 类型检查通过
- [x] 前端测试覆盖存储读写与「`undefined` 不得覆盖已保存记录 / `[]` 在恢复后可以覆盖」的判定；至少有一条在实现缺失时会失败
- [ ] 实机验证：普通模式折叠 `##` → 打开块工作区 → 回到文档，该标题仍折叠
- [ ] 实机验证：折叠后立刻切换模式（不等去抖），折叠仍在
- [ ] 实机验证：同一台设备刷新后 markdown 标题折叠仍在

## Comments

实现已落地：`src/singleDocFolds.ts`、`src/SingleDocView.tsx` 在 `onReady` 且语言为 markdown 后恢复；卸载走 `readFoldRecordSync` + `foldMementoForFlush`。`npm test` 108 pass，`npm run check` 通过。跨设备不同步是规格天花板。实机模式切换仍待人工。
