# Brief: Mobile paste desync and sidebar drawer fixes

## Topic
对 rustpad fork 的两个移动端缺陷修复做一轮异构代码评审:普通模式「粘贴只进首字符后失同步」、移动端「侧边栏无法显示」。

## Background
- 普通模式 `src/rustpad.ts` 的 `onChange` 原本用 Monaco `event.changes`(rangeOffset/rangeLength/text)相对 `lastValue` 重建 OT 操作。移动端粘贴/输入法走 composition,`event.changes` 不忠实描述增量 → 生成 base_len 错误的操作 → 服务端 `apply_edit` 的 transform/apply 失败 → 丢连接 → 非法 op 卡在 outstanding,每 1s 重连重发,5 次失败后 `onDesynchronized`。本次改为对 `lastValue` 与 `getValue()` 求公共前缀/后缀最小 diff。
- `Sidebar.tsx` 与 `BlockPageView.tsx` 内联侧栏有 `display={{ base:"none", sm:"block" }}`,在 <480px 硬隐藏,与展开按钮(`sidebarCollapsed` 挂载/卸载)正交并被其覆盖。本次改为覆盖式抽屉 + 半透明遮罩,默认折叠改为按窗口宽度。
- 分块模式经 `src/rustpad-headless.ts` 全量 `getValue` 同步(buildReplaceOp),本就免疫粘贴问题,本次未改其同步逻辑。

## Goals
1. 校验 diff 算法正确性(base_len/target_len、UTF-16 代理对边界、删除/插入/替换/整段粘贴)与回归风险(多光标合并、远端光标 transform、与 server `apply_edit` 的契合)。
2. 校验抽屉改造的正确性(定位/层级/遮罩/默认折叠/共享 localStorage 键)与桌面端无回归。
3. 确认两个缺陷确实被修复且未引入新问题。

## Constraints
- 仅评审 correctness / regression / spec 一致性,不评 style。
- 不扩大改动范围(YAGNI):分块同步逻辑与服务端不在本次改动内。

## Success criteria
评审给出明确 verdict;阻断性问题被指出或确认无阻断;tsc/build 通过的结论被复核。
