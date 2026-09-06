# 03: 抽出块清单操作纯函数模块（纯搬移）

**What to build:**
块清单的增删改移从 React 钩子里搬进一个纯函数模块，用户可观察的行为完全不变，但从此可以脱离 React 单独测试。这是后续六张票的地基。完整背景见同目录
`spec.md`。

**本票只搬移当前已有的行为。**
置顶置底、按位置添加、更新布局、结构校验、遗留迁移等函数由各自的票在这个模块上生长，不在本票一次抽干净。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] 存在一个不依赖 React 的纯函数模块，承载块清单的解析、序列化、添加、删除、上移、下移、更新块字段
- [x] 本票不新增任何函数、不改变任何可观察行为
- [x] 块清单 React 钩子只保留协同同步与状态管理，所有清单转换调用该模块
- [x] 模块测试覆盖：上移、下移、添加、删除、更新块字段
- [x] 边界用例均断言「无变化」：首位上移、末位下移、单块清单、空清单、目标 id 不存在
- [x] 解析测试覆盖：正常清单、空文本、非法 JSON
- [x] 若尚不存在，添加一个一条命令跑完所有测试文件的 npm 脚本
- [x] 类型检查通过、测试通过
- [ ] 实机回归：添加块、删除块、上移、下移、改标题、改语言，行为与改动前一致

## Comments

由 grok lane 实现（`grok_session_id` 1bb9f1a7-8257-4c87-a160-c34d84f06923）。

落地：

- 新增 `src/manifestOps.ts`：`parseManifest` / `serializeManifest` /
  `createDefaultBlock` / `addBlock` / `removeBlock` / `updateBlock` /
  `updateTitle` / `moveBlock`，不依赖 React、DOM、Monaco。
- 新增 `scripts/manifestOps.test.ts`（18 例）。
- `src/BlockManifest.ts` 的 `useManifest` 只剩协同同步与 React 状态；类型与
  `createDefaultBlock` 从新模块再导出，对外签名不变。

架构侧核验：

- 逐函数比对搬移前后代码，语义逐条等价，含 `moveBlock`
  在无变化时返回同一引用（因而 `setManifest` 不触发重渲染、`replaceContent`
  不产生网络写入）这一细节。
- `src/BlockPageView.tsx` 与 `src/BlockEditor.tsx`
  零 diff，这是「零行为变更」的判据。
- 测试用 `Object.freeze` 冻结输入，ESM 严格模式下任何原地修改都会抛错。
- 变异测试：去掉 `moveBlock` 的越界守卫后 3 条边界用例转红，还原后转绿。

待人工验收：浏览器里添加块、删除块、上移、下移、改标题、改语言的行为回归。
