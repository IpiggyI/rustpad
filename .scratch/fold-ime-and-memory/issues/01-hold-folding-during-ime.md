# 01: IME 组合期间不跑折叠控制器更新

**What to build:**
输入法组合从开始到结束，Monaco 折叠控制器不得重写装饰、不得重设 hidden areas。组合结束后再补一次折叠计算。完整背景见同目录 `spec.md` 实现决策第一条。

**Blocked by:** 无

**Status:** needs-triage

- [x] 组合整段内对该编辑器实例 `triggerFoldingModelChanged` no-op；start 时 cancel in-flight promise 与 scheduler；end 时调用原 trigger
- [x] 由 `Rustpad` 接到已有的 composition 监听上，块编辑器与普通模式共用
- [x] 字段缺失时跳过，不抛到编辑流程
- [x] 组合期间折叠持久化与恢复 no-op（与 02 共用守卫）
- [x] 类型检查通过
- [x] 前端测试：对假 FoldingController 在 start→trigger→end 序列上断言组合中不调用原 trigger、结束后调用一次；至少有一条在实现缺失时失败

## Comments

Lane: hold is `createFoldingImeHold` / `attachFoldingImeHold` in `src/markdownFolding.ts`, started and ended from `Rustpad` composition listeners. Tests in `scripts/foldingImeHold.test.ts`. `npm test` and `npm run check` pass.

## Comments

2026-09-11 实机（报告人）：hold 已接到本地 `npm run dev` + `cargo run`。折叠记忆另票已过；**输入闪烁仍在**。本票实现了「组合期间 no-op `triggerFoldingModelChanged`」，但没有消除用户症状，因此该机制不是根因，或不是充分条件。不要再把本票当作闪烁已修。后续诊断见 `03-input-flicker-root-cause-unknown.md`。
