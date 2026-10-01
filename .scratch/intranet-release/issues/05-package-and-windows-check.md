# 05: 打包与 Windows 实机验证

**What to build:** 在 WSL 里运行一个脚本，产出可以在 Windows
x64 主机上解压后双击运行的 zip。完整背景见同目录 `spec.md` 的“打包”一节。

**Blocked by:** 02, 03, 04

**Status:** ready-for-agent

- [ ] 打包脚本在 WSL 里依次构建 wasm、前端，并调用 Windows 侧 `cargo.exe` 编译
      `x86_64-pc-windows-msvc` 的服务端
- [ ] 脚本在 `release/` 下生成 zip；`release/` 加入 `.gitignore`
- [ ] zip 内有
      `rustpad.exe`、`dist\`、`.env`（`SQLITE_URI=sqlite://rustpad.db`、`PORT=3030`、`RUST_LOG=info`）和
      `使用说明.txt`
- [ ] `使用说明.txt`
      用中文写，覆盖 spec 列出的全部内容，Windows 记事本能正确显示中文
- [ ] 任何一步失败时，脚本以非零退出码停止，并指出是哪一步
- [ ] 在 Windows 临时目录解压 zip，从 WSL 启动
      `rustpad.exe`：控制台横幅正常，首页能打开，编辑器能加载，`rustpad.db`
      已生成
- [ ] 停止后再启动，之前写的页面内容还在
- [ ] README 的部署一节补充内网版的说明，或指向打包脚本和使用说明
- [ ] 报告 zip 和 exe 的大小
- [ ] 以下项目交给用户验证，验证前标为“未验证”：资源管理器双击启动、防火墙弹窗、真实手机或其他电脑访问、真实断网环境

## Comments
