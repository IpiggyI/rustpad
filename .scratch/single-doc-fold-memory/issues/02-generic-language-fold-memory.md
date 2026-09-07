# 02: 普通模式折叠记忆覆盖任意可折叠语言

**What to build:**
普通模式的折叠记忆不再仅限 markdown。XML、JSON 以及其它 Monaco 会计算折叠范围的语言，切到块模式再回来、本机刷新后，折上的区域仍折着。同一文档换语言时，各语言的记录分开存。完整背景见同目录 `spec.md`。

块模式已经按块清单记住任意语言，不要改那条路径的语义。

**Blocked by:** 01

**Status:** ready-for-human

- [x] 普通模式按文档 id **和语言** 读写折叠记录；不再在 `language === "markdown"` 时才恢复/持久化
- [x] 旧键 `single-doc:folds:${id}` 仅作为 markdown 的遗留读取，且只在带语言的键缺失时用
- [x] 语言切换时把本轮语言的 memento 写入该语言的键，不覆盖目标语言的记录
- [x] 卸载同步写出本轮语言的 memento；`undefined` 不覆盖已保存记录，恢复后的 `[]` 要写入
- [x] 块编辑器仍对任意语言写块清单 `folds`，行为与现在一致
- [x] 类型检查通过
- [x] 测试覆盖：不同语言键隔离；markdown 遗留键；JSON/XML 与 markdown 同等的 persist/flush 判定（至少一条在仍仅 markdown 时失败）
- [ ] 实机验证：普通模式 JSON/XML/markdown 各折一处 → 切块模式再回来仍折着
- [ ] 实机验证：同一文档 markdown 与 JSON 的折叠互不覆盖

## Comments

已去掉普通模式的 markdown 专用门。键为 `single-doc:folds:${id}:${language}`。`npm test` 112 pass，`npm run check` 通过。跨设备仍不在本票范围。
