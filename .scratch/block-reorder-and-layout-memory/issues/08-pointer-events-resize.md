# 08: 块高度手柄改指针事件（支持触摸）

**What to build:**
手机上可以拖动块底部的手柄调整块高度。目前该手柄只监听鼠标事件，触摸完全无效 —— 一旦高度变成跨设备同步的状态（票 06），手机端就会变成「只能看别的设备设的高度、自己改不了」。完整背景见同目录
`spec.md`。

指针事件是鼠标事件的超集，改造后鼠标行为不变，同时获得触摸支持。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] 高度拖拽手柄改用指针事件与指针捕获，同时支持鼠标与触摸
- [x] 鼠标拖拽行为与改动前一致，含拖拽期间禁止文字选中、松开后恢复
- [x] 高度上下限沿用现有值
- [x] 触摸拖拽期间页面不跟着滚动
- [x] 类型检查通过
- [ ] 实机验证：手机上拖动手柄能改变块高度
- [ ] 实机验证：桌面端鼠标拖拽无回归

## Comments

由 grok lane 实现（`grok_session_id` 9c1960ff-57ca-4a2c-b483-1eaac53697b9）。

落地：`src/BlockEditor.tsx` 的 `startResize` 改用 `React.PointerEvent` +
`setPointerCapture`，document 上监听 `pointermove` / `pointerup` /
`pointercancel`，按 `pointerId` 过滤。手柄 `onMouseDown` → `onPointerDown`，并加
`style={{ touchAction: "none" }}`（Chakra `Box` 的类型不接受 `touchAction`
prop）。

架构侧核验：

- 高度上下限 120 / 1200 一个数字未改。
- 拖拽期间 `document.body.style.userSelect = "none"`、结束恢复，与改动前一致。
- `pointercancel` 与 `pointerup` 走同一清理路径，不留悬空监听。
- `setPointerCapture` 在任何状态写入之前调用，即便抛 `InvalidPointerId`
  也不会留下半开状态。
- 保留文件（`BlockManifest.ts` / `blockModeSync.ts` /
  `BlockPageView.tsx`）零 diff。

本票按 spec 不写自动化测试（手势行为依赖真实 DOM），待人工验收两条实机项。
