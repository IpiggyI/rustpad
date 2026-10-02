# 06：图片预览可以收起，状态在设备之间共享

**What to build:**
在含图片引用的行的行号旁显示图标，点击收起或展开这一行的图片预览；收起状态像标题折叠一样记录并共享。规则见同目录 `spec.md`
"第三期"一节的"收起与展开"和"记忆"，以及 [ADR 0008](../../../docs/adr/0008-image-preview-collapse-stored-with-folds.md)。

**Blocked by:** 无

**Status:** ready-for-agent

- [x] 含本服务端图片引用的行显示图标，两种状态外观不同，提示文字为 `Collapse image preview` / `Expand image preview`
- [x] 点击图标收起或展开这一行全部图片；收起后预览不占空间
- [x] 没有图片引用的编辑器不多出行号栏列，正文不右移
- [x] 块模式：状态写入块清单 `collapsedImages`；收起后刷新仍收起，另一个独立存储的浏览器上下文也看到收起
- [x] 新字段经过所有复制或重建块数据的路径（初始清单、快照保存、`useManifest` 初始状态等处理 `folds` 的地方）都不丢失
- [x] 单文档模式：状态写入旁路文档保留键 `@collapsedImages`，与折叠写入走同一条合并路径；先折叠标题再收起预览、先收起预览再折叠标题，两种顺序在刷新后和另一个上下文里都保持
- [x] 保留键不会被当成某个语言的折叠记录写入本地缓存或恢复，写回时也不会被丢掉
- [x] 同一张图片被引用多次时一起收起
- [x] 类型检查和单元测试通过；单元测试覆盖块清单字段和旁路保留键的读写

## Comments

实现见 `src/imagePreview.ts`、`src/manifestOps.ts`、`src/blockModeSync.ts`、`src/singleDocFolds.ts`。车道按要求核对了所有复制或重建块数据的路径，以及旁路文档里遍历语言键的三处（写本地缓存、播种、恢复）。

首轮把公共模块写成了 `src/imageNames.js`，与 `src/` 里其他 TypeScript 模块不一致；返工改为 `src/imageNames.ts`，行为不变。

验证：`cargo test -p rustpad-server`、`npm run check`、`npm test`（249 项）通过；后端改用 3031 端口后，`imagePaste.browser.mjs`、`imagePreview.browser.mjs`
通过，包括两种模式下收起后刷新和另一个独立存储的浏览器上下文都保持收起、折叠与收起两种顺序都保持、同一图片一起收起、无图片的编辑器行号栏宽度不变。回归：其余 11
个浏览器脚本全部通过，`headingEnter` 43 项、`foldMemory` 16 项。
