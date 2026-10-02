# 05：只有图片本身可以点击

**What to build:**
预览里只有图片本身（加载失败时是那行错误说明）可以点击打开原图；同一水平线上图片右侧的空白处不响应。规则见同目录 `spec.md`
"第三期"一节的"点击区域"。

**Blocked by:** 无

**Status:** ready-for-agent

- [x] 点击图片在新标签页打开原图
- [x] 点击预览区域内、图片右侧的空白处不打开任何页面
- [x] 浏览器测试包含上面这条反向断言

## Comments

实现见 `src/imagePreview.ts`。浏览器测试 `blank preview space opens no popup` 在单文档和分块两种模式下验证图片右侧空白不打开页面。
