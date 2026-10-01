# 01: 复制在非 HTTPS 地址下降级（main）

**What to build:** 所有复制按钮在 `navigator.clipboard` 不可用时改用隐藏文本框加
`document.execCommand("copy")`，这样其他设备通过 `http://<局域网IP>`
访问时也能复制。这项改动提交在 main 上，再合并到 `intranet`。完整背景见同目录
`spec.md` 的“复制降级（main）”一节。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 5 个复制入口都走同一个复制函数：`src/Sidebar.tsx`
      的复制链接、`src/SingleDocView.tsx` 的复制内容、`src/BlockPageView.tsx`
      的复制链接和两处复制内容
- [x] `navigator.clipboard` 存在且成功时，行为不变
- [x] `navigator.clipboard` 不存在或 `writeText`
      抛错时，走降级路径；降级成功提示 "Copied!"
- [x] 降级也失败时提示 "Copy failed"，不能假装成功
- [x] 降级路径不改变页面焦点所在的编辑器内容，也不留下多余的 DOM 节点
- [x] 浏览器测试从非安全上下文（WSL 的局域网 IP）访问，点击复制后剪贴板内容与预期一致
- [x] `npm run check`、`npm test`、`npm run test:browser` 通过

## Comments

已在 main 实现（`2dc8d7f`），再合并进 `intranet`：

- `src/copyText.ts` 是共用的复制函数。`navigator.clipboard.writeText`
  成功时直接返回；接口不存在或被拒绝时，用屏幕外文本框加
  `execCommand("copy")`，完成后删除文本框，恢复原来的焦点和选区；两条路径都失败时抛错，界面提示 "Copy
  failed"。
- 5 个复制入口都改为调用 `copyText`。
- `scripts/clipboardFallback.browser.mjs` 从
  `RUSTPAD_LAN_URL`（非安全上下文）打开应用，在同一浏览器上下文里从
  `http://127.0.0.1:5173` 的页面读回剪贴板内容并比对；浏览器以
  `--no-proxy-server` 启动，因为本机设置了 `http_proxy`。

验证：`npm run check`、`npm test` 通过；改动文件的 prettier 检查通过；
`RUSTPAD_LAN_URL=http://192.168.2.100:5173` 下 `clipboardFallback`
的 6 项全部通过，包括单文档复制链接和内容、分块模式复制链接、复制全部、复制单块，以及降级失败时提示 "Copy
failed"。

`npm run test:browser` 里有两个已有测试失败，与本票无关。在不含本票改动的
`57c4488` 上用同样的方法各跑两次，结果如下：

- `reorderBlocks.browser.mjs:566`
  两次都超时：堆叠展示下拖动块头手柄后，侧边栏顺序没有变化。这是 main 上的确定性失败。
- `headingEnter.browser.mjs` 一次通过、一次在第 398 行失败，属于偶发失败。

这两个问题没有在本次处理。
