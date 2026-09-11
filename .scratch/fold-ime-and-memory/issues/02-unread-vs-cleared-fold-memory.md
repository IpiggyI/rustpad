# 02: 未读不得当清空；恢复可核验；卸载 flush

**What to build:**
折叠读结果区分「未读」与「用户全部展开」；块编辑器卸载同步写出 last-good；恢复在折叠模型真正可应用之后生效，且不会在恢复结束后把用户展开的区再折上；旁路文档关掉 socket 之前送出 outstanding 与 buffer。完整背景见同目录 `spec.md`。

**Blocked by:** 01（共用 `markdownFolding` 读语义与 composing 守卫；可同一车道一次落地）

**Status:** ready-for-agent

- [x] `mementoFromHandle` / 同步读 / 异步读：无 model 或 `regions.length === 0` → `undefined`；有 regions 且 `getMemento()` 为 `undefined` → `[]`；不再把一切 `undefined` 收成 `[]`
- [x] `undefined` 不得写入清单或 sidecar/localStorage 覆盖已保存记录；块编辑器删除 `next === undefined ? [] : next` 这条强制清空
- [x] `saveSingleDocFolds` 不得把 `undefined` 存成 `[]`
- [x] 真 `[]`（模型已就绪、当前无折上区）在非 restoring、非 composing 时仍可覆盖已保存记录；`foldMementoForFlush(lang, lang, [], saved)` 仍为 `[]`
- [x] 改正把「未读当成清空」写死的测试（`scripts/singleDocFolds.test.ts` 里 flush live=`[]` 的语义保持为真清空；新增未读 `undefined` 与 `regions.length===0` 用例）
- [x] 恢复优先 `restoreViewState({ collapsedRegions })`；仅在 restoring 会话内按折叠模型变化重试；核验成功或一次就绪计算全不对上则结束并取消订阅
- [x] 块编辑器：`onDidChangeHiddenAreas` 记 last-good；cleanup 同步 flush；不得只 `persist.cancel()`
- [x] 自己的 sidecar/清单回声不得再 restore
- [x] `RustpadHeadless.dispose` 前送出 outstanding 与 buffer
- [x] 类型检查通过
- [x] 前端测试覆盖：未读不覆盖、真清空覆盖、块 flush 在 cancel 去抖后仍写出 last-good、dispose 送出 buffer；至少各有一条在实现缺失时失败

## Comments

Lane: unread vs `[]` is in `mementoFromHandle`; unmount flush uses last-good after `persist.cancel()`; sidecar/block echoes skip equal records; headless dispose sends a buffered `replaceContent` at `revision+1`. Tests in `scripts/markdownFolding.test.ts`, `scripts/singleDocFolds.test.ts`, `scripts/rustpadHeadless.test.ts`. `npm test` and `npm run check` pass.

## Comments

2026-09-11 实机（报告人）：普通模式与块模式反复切换多次，已折内容未再自行展开。本票用户可见行为暂视为通过。输入闪烁与本票无关，见 `03-input-flicker-root-cause-unknown.md`。
