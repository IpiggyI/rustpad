# 04: 首页与最近页面

**What to build:** 不带 `#`
的地址显示首页。首页可以打开页面、新建页面，并列出本设备的最近页面。分块工作区的侧边栏增加 “Home” 入口。完整背景见同目录
`spec.md` 的“首页与最近页面”一节，术语见 `CONTEXT.md` 的“最近页面”。

**Blocked by:** 01（先合并 main，保证分支起点一致）

**Status:** resolved

- [x] 不带 `#`
      的地址显示首页，不再新建随机单文档；`#page:<id>`、`#<id>`、`#folds:`
      的处理不变
- [x] 首页“打开页面”接受页面 id，也接受包含 `#page:<id>`
      的完整链接；输入无效时提示，不跳转
- [x] 首页“新建页面”跳到新的 `#page:<id>`
- [x] 最近页面单独存一个本地存储键，不复用块快照；读写逻辑在独立模块里，存储对象可注入
- [x] 打开分块工作区页面时写入或更新记录；页面标题变化时更新记录里的标题；单文档不写入
- [x] 列表每行显示标题（没有标题时显示 id）和本设备最后一次打开的时间，按时间从新到旧排序
- [x] 每行可以“从列表移除”，不需要确认，只删除本设备的记录
- [x] 存储里的数据损坏时，列表为空，不抛错
- [x] 分块工作区侧边栏有 “Home” 入口，点击回到首页
- [x] 界面文字为英文
- [x] 最近页面模块有 `node --test` 单元测试，覆盖 spec 列出的用例
- [x] 首页有浏览器测试，覆盖 spec 列出的场景，并加入 `npm run test:browser`
- [x] `npm run check`、`npm test`、`npm run test:browser` 通过

## Comments

已实现（`c65d497`）：

- `src/useHash.ts` 的 `routeHash()` 把空哈希路由到首页；`#folds:`
  仍然新建单文档。
- `src/HomePage.tsx` 是首页；`src/pageOpenInput.ts` 解析“打开页面”的输入；
  `src/recentPages.ts` 用 `recentPages` 键保存最近页面，存储对象可注入。
- `src/BlockPageView.tsx`
  在打开页面时写入记录，在块清单标题变化时更新记录，侧边栏增加 “Home” 按钮。

验证（由运行器执行，Grok 会话 `0e04a75e-ddcb-4cbd-b46a-63d4b36ae548`）：
`npm run check`、`npm test`（235 项）、改动文件的 prettier 检查、`npm run build`
通过；浏览器套件 13 个脚本中 12 个一次通过，`reorderBlocks`
仍是已知的第 566 行失败； `homePage.browser.mjs` 的 10 个场景全部通过。

待决：最近页面的写入失败会被直接忽略。这沿用了 `src/currentBlock.ts` 和
`src/blockPresentation.ts`
的写法，但与“出错不能静默吞掉”的全局要求冲突，已报告给用户决定。
