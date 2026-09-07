# 03: 普通模式折叠记录写入旁路协同文档，跨设备生效

**What to build:**
A 设备普通模式折上的区域，B 设备打开同一 `#<id>` 文档时仍然折着。任意 Monaco 能折的语言都要如此。切模式、刷新仍要保住。完整背景见同目录 `spec.md` 与 `docs/adr/0003-single-doc-folds-in-sidecar-collab-doc.md`。

旁路文档 id：`folds:${id}`。内容：`{ [language]: memento }`，键排序后序列化。本地存储降为缓存。初始化只播种一次；之后服务端为准。

**Blocked by:** 02

**Status:** ready-for-human

- [x] `RustpadHeadless` 连接 `folds:${id}`；JSON 按语言分键；规范化序列化
- [x] 旁路为空/不可用时，把该 id 下所有语言的本地缓存一次性播种；之后不得再从本地覆盖服务端
- [x] 损坏或非规范文本按块清单同类策略自愈（第一个 JSON / 最近有效 / 规范化写回）
- [x] 当前语言的写入合并进整份映射，其它语言的键保留
- [x] 本地键仍作缓存；卸载时先同步本地再 `replaceContent` 然后 `dispose`
- [x] `parseHash` 保留 `folds:` 前缀，不能把旁路文档当正文打开
- [x] 不改 rustpad-server，不写块清单，不改块模式折叠语义
- [x] 类型检查通过
- [x] 测试覆盖：播种只一次且含全部语言；服务端非空时本机不得覆盖；按语言合并；`folds:` 前缀保留；至少一条在仍只写 localStorage 时失败
- [ ] 实机验证：A 设备普通模式折 JSON/XML/markdown → B 设备打开同一 `#id`，折叠仍在
- [ ] 实机验证：切块模式再回来，折叠仍在

## Comments

旁路文档 `folds:${id}` 已接上。`npm test` 129 pass，`npm run check` 通过。同一文档的其他查看者会看到相同折叠（ADR 0003）。
