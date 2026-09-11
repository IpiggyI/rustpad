# 输入行闪烁的根因与验证

## 结论

2026-09-11，已在现有 Rustpad 应用中复现输入行短暂显示别处正文，并通过单变量对照确认：实际运行的 Monaco
0.43.0 在构造原生输入框缓冲区时混用了文档坐标与显示坐标。现已修复加载器配置，实际应用的浏览器复现检查通过；报告人于 2026-09-11 在 Windows 小狼毫原机确认输入闪烁不再出现。

修复前，项目安装 `monaco-editor@0.52.2`，但 `@monaco-editor/loader@1.4.0`
默认加载 CDN 的 0.43.0。应用未覆盖版本，用户实机报告和本地浏览器请求均确认实际版本为 0.43.0。修复后，`src/index.tsx`
在初始化前调用 `loader.config`，CDN 路径中的版本取自已安装的
`monaco-editor/package.json`，当前为 0.52.2。

## 因果链

1. 折叠后，文档行号与显示行号不同。例如文档第 12 行变成显示第 3 行。
2. Monaco 为输入框准备光标前后的文本。`PagedScreenReaderStrategy.fromEditorSelection`
   在无障碍状态为未知、文本超过 500 字符时调用 `modifyPosition` 截断。
3. 0.43.0 的 `ViewModel.modifyPosition`
   把输入位置从显示坐标转为文档坐标，移动字符偏移后，直接返回文档坐标，漏了转换回显示坐标。
4. 调用方把返回值当显示坐标构造范围，`getValueInRange`
   又将它转为文档坐标。缓冲区因此包含错误范围内的文字。范围还可能被重排或限制到最后可见行，所以错误文字可以来自末尾折叠标题。
5. 组合输入开始后，Monaco 将原生 `textarea`
   显示在输入行上方。错误缓冲区随组合字母一起显示；正文模型与底下的正文行 DOM 仍正确。提交后输入框隐藏，正确正文重新可见。

关键源码位置（相对各版本发布包）：

- `esm/vs/editor/browser/controller/textAreaState.js`：`PagedScreenReaderStrategy.fromEditorSelection`，0.43.0 第 184–221 行。
- `esm/vs/editor/common/viewModel/viewModelImpl.js`：`modifyPosition`，0.43.0 第 603–605 行。
- `esm/vs/editor/browser/controller/textAreaHandler.js`：输入框内容提供器、组合开始与结束监听，0.43.0 第 177–226、277–352 行。
- `esm/vs/editor/common/viewModel/viewModelImpl.js`：0.52.2 第 614–617 行，已在返回前调用
  `convertModelPositionToViewPosition(resultModelPosition)`。

20 行样本的实测换算：显示位置 `(3,16)` 对应文档
`(12,16)`；向前取 500 字符返回文档
`(8,19)`。旧版把它当显示第 8 行，映射到文档第 17 行。输入框中出现
`ROW 17 … nihao`，而模型中仍是 `ROW 12 … nihao`。

## 反馈环与对照

浏览器脚本：[reproduce-input-flicker.mjs](reproduce-input-flicker.mjs)。脚本向临时本地服务的新建诊断文档写固定样本，不读取真实文档。

| 条件                                        | 观察结果                                 |
| ------------------------------------------- | ---------------------------------------- |
| 20 行长文本，折叠第 1 节，在第 12 行输入    | 0.43.0 混入第 17 行文字                  |
| 30 行长文本，折叠第 1、3 节，在第 16 行输入 | 0.43.0 混入末尾标题 `# HEADER 21` 的前缀 |
| 同一样本，只在浏览器内补上返回坐标转换      | 两个样本均正常                           |
| 同一样本，将加载资源替换为已安装的 0.52.2   | 两个样本均正常                           |
| 恢复原版 0.43.0 再跑一次                    | 两个样本均重现                           |

所有对照均实际检查原生 `textarea`
的内容。每个异常样本同时断言：隐藏区域变化为 0、滚动位置符合预期、其他正文未变化、正文行 DOM 与模型一致。提交后确认
`ime-input` 消失，并保存前后截图。

缩小样本时，取消折叠或将每行填充从 150 字符缩短至 30 字符，错误消失。此前的短文档测试未触发 500 字符截断路径，因此未能复现。

本轮已运行的命令（仓库根目录；要求本地临时前后端分别监听 5173、3030）：

```sh
RUSTPAD_DIAG_PLAYWRIGHT=/tmp/rustpad-input-diagnosis/node_modules/playwright/index.mjs \
RUSTPAD_DIAG_OLD_MONACO=/tmp/rustpad-input-diagnosis/monaco-0.43/package \
node .scratch/fold-ime-and-memory/diagnostics/reproduce-input-flicker.mjs
```

输出：`实际应用加载版本： [ '0.52.2' ]`、`验证通过：全部所选样本符合预期，实际应用的输入缓冲区与正文一致。`

脚本保留原版与单点修正对照，并新增实际应用检查。加上
`RUSTPAD_DIAG_APPLICATION_ONLY=1`
可单独运行实际应用检查。该检查在修改产品代码之前因第 12 行缓冲区出现第 17 行文字而失败；修改后两个样本均通过。实际应用检查不替换请求版本，不修改 Monaco 内部方法，并断言请求版本等于项目安装版本。

浏览器测试按请求版本提供本机同版本发布包资源，避免 CDN 网络加载干扰。另已通过 HTTP 下载 0.52.2 的 `loader.js` 与 `editor.main.js`，逐字节确认与本机发布包一致。旧版因果对照则显式替换资源。测试未使用用户真实文档。

环境变量分别指向临时 Playwright 入口和解包后的官方
`monaco-editor@0.43.0`。这些依赖未加入项目。截图目录由脚本输出。旧版源码与临时依赖若被清理，需要重新准备。

## 用户采样与先前尝试

用户已确认 Windows Chrome
151、小狼毫、单文档模式在采样期间发生输入行闪烁。`hiddenAreaChanges: 0`、`outsideEditedLineChanged: false`
与本次复现一致。

第一版诊断脚本只检查滚动位置和其他正文是否变化，没有校验输入框缓冲区的文字是否正确。`anomalies: []`
因此漏报了本次错误。`displayedLine`
是按滚动量推算的缓冲区行号，不是对画面的识别结果。

远程光标守卫与组合期间冻结折叠更新均不改变上述缓冲区坐标换算。静态折叠已经足以使两种坐标不同，所以无需在组合期间发生折叠更新，也能触发问题。末节展开的 20 行样本同样复现，符合用户先前报告。

## 已实施修复与验证边界

Monaco 加载器现已显式使用项目安装版本，使当前运行版本为已验证的 0.52.2。只修改
`package.json`
或重新安装依赖不会改变当前加载器的 CDN 默认值。浏览器中的单点坐标修正仅用于验证因果，不作为产品补丁交付。

产品改动仅在
`src/index.tsx`。已通过浏览器因果对照与实际应用复现检查、`npm run check`、`npm test`（141 项）、`npm run build`、脚本语法与格式检查。尚未在用户 Windows 原机验证版本切换后的最终效果，也未复现“删除来源文字再撤销后来源改变”的操作序列。
