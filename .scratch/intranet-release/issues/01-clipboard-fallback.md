# 01: 复制在非 HTTPS 地址下降级（main）

**What to build:** 所有复制按钮在 `navigator.clipboard` 不可用时改用隐藏文本框加
`document.execCommand("copy")`，这样其他设备通过 `http://<局域网IP>`
访问时也能复制。这项改动提交在 main 上，再合并到 `intranet`。完整背景见同目录
`spec.md` 的“复制降级（main）”一节。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 5 个复制入口都走同一个复制函数：`src/Sidebar.tsx`
      的复制链接、`src/SingleDocView.tsx` 的复制内容、`src/BlockPageView.tsx`
      的复制链接和两处复制内容
- [ ] `navigator.clipboard` 存在且成功时，行为不变
- [ ] `navigator.clipboard` 不存在或 `writeText`
      抛错时，走降级路径；降级成功提示 "Copied!"
- [ ] 降级也失败时提示 "Copy failed"，不能假装成功
- [ ] 降级路径不改变页面焦点所在的编辑器内容，也不留下多余的 DOM 节点
- [ ] 浏览器测试从非安全上下文（WSL 的局域网 IP）访问，点击复制后剪贴板内容与预期一致
- [ ] `npm run check`、`npm test`、`npm run test:browser` 通过

## Comments
