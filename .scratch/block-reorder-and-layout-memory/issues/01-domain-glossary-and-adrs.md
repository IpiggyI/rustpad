# 01: 领域术语表与两篇 ADR

**What to build:**
仓库获得一份领域术语表和两篇架构决策记录。术语表让后续每一票的用词一致；两篇 ADR 把「不写下来后人一定会困惑」的两个决策固定下来。完整背景见同目录
`spec.md`。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] 仓库根目录有术语表，至少定义：页面、块、块清单、布局状态、块快照、分块工作区
- [x] 每个词条与代码里的实际标识符对齐，不引入代码中不存在的同义词
- [x] 术语表只含术语定义，不含实现细节、方案或待办事项
- [x] 有一篇 ADR 记录「块布局状态存入共享块清单」：背景说明本项目无账号系统，因此「跨设备同步」与「个人视图隔离」只能二选一；决策为选前者；后果明确写出「同一页面的其他查看者会看到相同布局」
- [x] 有一篇 ADR 记录「接受字符级 OT 承载结构化块清单的天花板」：含并发场景实测数据表、「改成一行一个块的 JSONL 格式同样失败」的结论、以及推翻该决策的可观察触发条件
- [x] ADR 的编号、命名与存放位置遵循仓库既有约定
- [x] 两篇 ADR 都只记录已经做出的决策，不描述尚未决定的事项

## Comments

已实现（架构侧直接落笔，术语表与 ADR 属协调产物，不走实现 lane）：

- `CONTEXT.md`：8 个词条，每条带 `_避免_`
  同义词禁用列表。所有代码标识符经 grep 核实存在：`Rustpad` / `RustpadHeadless`
  / `SingleDocView` / `pageId` / `BlockInfo` / `BlockEditor` / `generateBlockId`
  / `Manifest` / `useManifest` / `BlockSnapshot`。
- `docs/adr/0001-block-layout-state-in-shared-manifest.md`：布局状态存入共享块清单。
- `docs/adr/0002-character-ot-for-structured-manifest.md`：接受字符级 OT 的天花板，含并发实测表、JSONL 否决结论、推翻触发条件。

`docs/adr/` 此前不存在，按 `ADR-FORMAT.md` 从 `0001`
起编号。`npx prettier --check` 全绿。
