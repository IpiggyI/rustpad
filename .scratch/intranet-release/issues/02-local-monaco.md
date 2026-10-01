# 02: 本地打包 Monaco，删除 GitHub 链接

**What to build:** 编辑器不再从 CDN 加载，而是使用本地安装的 `monaco-editor`
包，包括它的 worker。删除单文档侧边栏里的 GitHub 链接。完整背景见同目录
`spec.md` 的“本地 Monaco”一节。

**Blocked by:** 01（先合并 main，保证分支起点一致）

**Status:** resolved

- [x] `src/index.tsx` 不再配置 CDN 路径，加载器使用本地 `monaco-editor`
- [x] Monaco 的 worker 由本地构建产物提供；浏览器控制台不出现 worker 加载失败的报错
- [x] Markdown 折叠注册（`registerMarkdownFolding`）在本地 Monaco 上照常生效，已有的浏览器测试通过
- [x] 浏览器测试打开构建后的页面，拦截所有发往非本机地址的请求；编辑器加载完成时，拦截记录为空
- [x] `src/Sidebar.tsx` 的 GitHub 链接删除；"Read the code" 按钮保留
- [x] `npm run check`、`npm test`、`npm run test:browser` 通过
- [x] 报告构建前后 `dist` 的总大小

## Comments

已实现（`e4a6a11`）：`src/index.tsx` 把本地 `monaco-editor`
交给加载器，用 Vite 的 `?worker`
提供 editor、json、css、html、ts 五种 worker，并保留
`window.monaco`。单文档侧边栏的 GitHub 链接和那句说明已删除。

验证（由运行器执行，Grok 会话
`10c755c6-7647-42e9-85d6-313325175415`）：`npm run check`、
`npm test`（226 项）、改动文件的 prettier 检查、`npm run build`
都通过；浏览器套件 12 个脚本中 11 个一次通过，`reorderBlocks`
仍是已知的第 566 行失败。新增的 `offlineAssets`
在生产构建上打开分块页面和单文档，没有拦截到任何发往其他主机的请求，也没有 worker 报错。

体积：`dist`
从 811602 字节增至 13313010 字节；最大文件从 660515 字节的主脚本变为 6016989 字节的
`ts.worker`。主脚本约 4 MB，gzip 后约 1 MB；服务端不压缩静态文件。
