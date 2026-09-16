# 11：侧栏块行改为标题优先，滚动限制在块列表

**What to build:**
窄侧栏里块标题是最重要的信息。把每行压缩成"手柄 + 标题 + 菜单"，语言、排序和删除收进块菜单；块列表在自己的区域内滚动，侧栏其余部分留在原处。

**Blocked by:** 03、05、07 已完成。

**Status:** ready-for-agent

- [x] 每行只保留拖拽手柄、标题输入框和块菜单按钮；当前块用整行底色加左侧色条标识，不再用 ●/○ 按钮。
- [x] 块菜单包含语言选择、上移、下移、置顶、置底和删除；菜单固定 240 像素宽，靠近窗口边缘时收回窗口内，窄屏上每一项都可点到。
- [x] 点击行内任意位置（含标题输入框）选中该块；拖拽手柄和菜单按钮不选中，也只有手柄能发起排序。
- [x] 块列表占据侧栏剩余高度并在自身内部滚动，最小 160 像素；窗口过矮时外层侧栏仍可整体滚动，About 不会被裁掉后够不着。
- [x] 拖拽到列表边缘的自动滚动作用于块列表本身。
- [x] 更新受影响的浏览器脚本选择器与断言，全套检查通过。

## Comments

实现在 `src/BlockPageView.tsx`：`SidebarBlockRow`
精简为三个控件，`SidebarReorderMenu` 改名 `SidebarBlockMenu`
并接收语言与删除，新增 `place`
负责把菜单收回窗口内。侧栏容器改成纵向弹性布局，固定区与 About 各自包在 `Box`
里保持原有外边距合并，`nav[aria-label="Blocks"]` 取
`flex="1 1 auto"`、`minH={40}`、`overflowY="auto"`；`Add Block` 按钮移出
`nav`，随标题固定。

标题可用宽度从约 0 像素变成 14rem 侧栏下约 136 像素、20rem 侧栏下约 232 像素。行高仍为 32 像素。

测试钩子变化：`data-block-id` 与 `aria-current`
从 ●/○ 按钮移到行元素；`data-sidebar-reorder-menu` 改名
`data-sidebar-block-menu`；菜单根节点新增
`data-sidebar-menu`；`data-block-language` 与 `data-sidebar-remove-block`
仍在，但要先打开菜单。`sidebarBlocks`、`deleteBlock`、`reorderBlocks`、`integrated`
四个脚本按此调整。

行为变化：点击块名称现在会选中该块。原先 `sidebarBlocks.browser.mjs`
断言"点名称不改变当前块"，那条断言对应旧排版——名称只是六个控件中的一个小输入框。现在名称占满整行，若点它不选中，能选中的只剩几像素的内边距。断言改为"点名称选中该块"，并在其后显式切回原当前块，保证后续堆叠新增的断言仍检查它本来要检查的东西。

删掉一条断言：原先检查"从语言下拉框拖拽不触发排序"。语言下拉框已不在行内，该元素不存在；"行内只有手柄能拖"由名称、菜单按钮和行内边距三处断言覆盖。

验证：`npm run check` 无错，`npm test` 217 项通过，`npm run build`
通过，`npm run test:browser` 115 项通过，变更文件 `prettier --check` 与
`git diff --check`
均通过。真实浏览器截图检查了亮色 900x620、暗色 1400x900 和 390x844 窄屏三种情况，确认标题宽度、当前块标识、菜单收回窗口内和列表内部滚动。

未验证：窄屏用 Chromium 设备模拟，不是真实设备。键盘遍历菜单项的顺序没有专门检查。
