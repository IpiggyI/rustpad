# 02: 本地打包 Monaco，删除 GitHub 链接

**What to build:** 编辑器不再从 CDN 加载，而是使用本地安装的 `monaco-editor`
包，包括它的 worker。删除单文档侧边栏里的 GitHub 链接。完整背景见同目录
`spec.md` 的“本地 Monaco”一节。

**Blocked by:** 01（先合并 main，保证分支起点一致）

**Status:** ready-for-agent

- [ ] `src/index.tsx` 不再配置 CDN 路径，加载器使用本地 `monaco-editor`
- [ ] Monaco 的 worker 由本地构建产物提供；浏览器控制台不出现 worker 加载失败的报错
- [ ] Markdown 折叠注册（`registerMarkdownFolding`）在本地 Monaco 上照常生效，已有的浏览器测试通过
- [ ] `npm run build` 后，`dist` 里搜不到 `cdn.jsdelivr.net` 和 `unpkg.com`
- [ ] 浏览器测试打开构建后的页面，拦截所有发往非本机地址的请求；编辑器加载完成时，拦截记录为空
- [ ] `src/Sidebar.tsx` 的 GitHub 链接删除；"Read the code" 按钮保留
- [ ] `npm run check`、`npm test`、`npm run test:browser` 通过
- [ ] 报告构建前后 `dist` 的总大小

## Comments
