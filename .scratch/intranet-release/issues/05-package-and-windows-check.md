# 05: 打包与 Windows 实机验证

**What to build:** 在 WSL 里运行一个脚本，产出可以在 Windows
x64 主机上解压后双击运行的 zip。完整背景见同目录 `spec.md` 的“打包”一节。

**Blocked by:** 02, 03, 04

**Status:** resolved

- [x] 打包脚本在 WSL 里依次构建 wasm、前端，并调用 Windows 侧 `cargo.exe` 编译
      `x86_64-pc-windows-msvc` 的服务端
- [x] 脚本在 `release/` 下生成 zip；`release/` 加入 `.gitignore`
- [x] zip 内有
      `rustpad.exe`、`dist\`、`.env`（`SQLITE_URI=sqlite://rustpad.db`、`PORT=3030`、`RUST_LOG=warn`）和
      `使用说明.txt`
- [x] `使用说明.txt`
      用中文写，覆盖 spec 列出的全部内容，Windows 记事本能正确显示中文
- [x] 任何一步失败时，脚本以非零退出码停止，并指出是哪一步
- [x] 在 Windows 临时目录解压 zip，从 WSL 启动
      `rustpad.exe`：控制台横幅正常，首页能打开，编辑器能加载，`rustpad.db`
      已生成
- [x] 停止后再启动，之前写的页面内容还在
- [x] 用记事本另存过的 `.env`（CRLF 换行，可能带 BOM）仍能设置
      `SQLITE_URI`；如果做不到，启动横幅必须给出“未开启持久化”的警告
- [x] README 的部署一节补充内网版的说明，或指向打包脚本和使用说明
- [x] 报告 zip 和 exe 的大小
- [ ] 以下项目交给用户验证，验证前标为“未验证”：资源管理器双击启动、防火墙弹窗、真实手机或其他电脑访问、真实断网环境

## Comments

已实现（`17fd37b`，返工 `15dc032`）：

- `scripts/package-intranet.sh`：在 WSL 构建 wasm 和前端，把源码同步到 Windows
  `%TEMP%\rustpad-intranet-build` 后用 `cargo.exe` 编译 release 版服务端，生成
  `release/rustpad-intranet-windows-x64-<日期>-<提交号>.zip`。使用说明在打包时统一写成 BOM 加 CRLF，因为本机
  `core.autocrlf=input` 会把提交的模板存成 LF。
- `scripts/check-intranet-release.sh <zip>`：用 `Expand-Archive`
  解压，经 WSL 互操作启动 exe，检查横幅，运行
  `offlineAssets`，写入标记后强制结束再启动，确认标记还在，最后换成记事本格式的
  `.env` 再启动一次。
- `packaging/intranet/` 放 `.env` 和 `使用说明.txt` 模板。
- `rustpad-server/src/main.rs`：去掉 `.env` 开头的 BOM 再交给 dotenv；`.env`
  存在但读取失败时，在标准错误里说明原因。

验证（由运行器执行，Codex 会话
`01a0f6fb-3468-7192-bb69-9f8ba617b948`，返工续用同一会话）：打包、Windows 发布检查、`cargo test`、README 的 prettier 检查、无残留进程，全部通过；返工另加的检查也通过：损坏的
`.env`
会报出原因；模板去掉 CR 后打包，zip 内说明仍为 BOM 加 CRLF 且含全部英文界面标签；输出中没有 UNC 警告。

大小：zip 6127953 字节，`rustpad.exe` 6730240 字节。

验收时发现并返工的问题：`.env`
读取失败被吞掉；说明里的界面名称与英文界面不符；脚本输出 GBK 乱码的 UNC 警告；提交后的说明模板变成 LF。

未验证，等待用户反馈：资源管理器双击启动、防火墙弹窗、真实手机或其他电脑访问、真实断网环境。
