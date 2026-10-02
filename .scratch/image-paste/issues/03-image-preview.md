# 03：图片预览

**What to build:**
在图片引用所在行的下方显示图片预览，两种编辑器、所有语言都显示；点击预览在新标签页打开原图。规则见同目录 `spec.md`
的"前端（第二期：图片预览）"一节，那一节是本票的约束。

**Blocked by:** 02

**Status:** ready-for-human

- [x] 地址是 `api/images/<图片id>.<扩展名>` 的图片引用下方出现预览；外链图片不预览
- [x] 预览宽度不超过编辑区，高度不超过 320 像素，保持比例
- [x] 点击预览在新标签页打开原图
- [x] 图片加载失败时显示一行英文错误说明
- [x] 图片引用所在行被折叠时预览隐藏，展开后恢复
- [x] 本地或远端编辑增删图片引用后，预览跟着增删；已加载过的图片不让内容跳动
- [x] 预览不改正文、不写布局状态、不改变块高度
- [x] 类型检查通过
- [x] 浏览器测试：插入图片引用后预览出现且高度大于 0；删掉引用后预览消失；折叠所在标题后预览隐藏
- [ ] 实机验证：手机上点预览打开原图

## Comments

实现由 Codex 车道 `gpt-6.1-sol` 完成（接续 02 的会话 `01a0fd4f-a093-7fd0-aab4-104e41b559a6`），代码在
`src/imagePreview.ts`，两种编辑器在 `onMount` 里调用 `attachImagePreviews`。预览用 Monaco 的 view zone 实现，点击预览的处理挂在
document 的捕获阶段，只处理事件路径里包含预览链接的事件。

验证：`npm run check` 通过；`npm test` 243 项通过；`node scripts/imagePreview.browser.mjs`
在单文档和分块两种模式下各 9 项通过；`node scripts/imagePaste.browser.mjs` 10 项通过。

回归：其余浏览器脚本逐个运行，`foldMemory`、`compactHeights`、`currentBlock`、`singleBlock`、`rustpadClose`、`sidebarBlocks`、`deleteBlock`、`integrated`、`clipboardFallback`
直接通过；`reorderBlocks` 一次超时，重跑两次都通过。`headingEnter`
在这一轮没有完整通过，每次失败的断言不同（`multi-cursor` 的单文档或分块模式、普通行折叠箭头写入记录）。把两个编辑器文件还原到 02
之前的版本（`26d4ef9`，不含任何图片代码）后，它照样失败。随后重启后端和 vite，在 `b8f2323` 上连跑两次：第一次失败在
`multi-cursor`，第二次 43 项全部通过。所以这不是图片功能造成的回退。失败原因推断为依赖时序，没有证实。
