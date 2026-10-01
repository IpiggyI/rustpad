# 03: 服务端启动体验

**What to build:**
双击启动后，控制台用中文显示访问地址和数据位置；出错时说明原因并等待按键；在 Windows 下自动用局域网地址打开首页。完整背景见同目录
`spec.md` 的“服务端启动体验”一节。

**Blocked by:** 01（先合并 main，保证分支起点一致）

**Status:** resolved

- [x] 启动横幅用 `println!` 打印
      `http://<局域网IP>:<端口>/`；IP 用 UDP 套接字 connect 后读本端地址的方式选出，不发送数据包，不新增依赖
- [x] 选不出局域网 IP 时，打印 `localhost`，并说明其他设备要用主机的 IP 访问
- [x] 横幅说明数据文件位置；未设置 `SQLITE_URI`
      时，明确提示“未开启持久化，关闭窗口后数据丢失”
- [x] 当前工作目录下没有 `dist/index.html`
      时，打印醒目警告和当前工作目录，程序继续运行
- [x] 端口被占用、`SQLITE_URI` 打不开、`PORT` 或 `EXPIRY_DAYS`
      解析失败时，打印中文原因和处理办法；有控制台时等待按键，然后以非零退出码退出；没有控制台时直接退出
- [ ] 只在 Windows 下，监听成功后用默认浏览器打开首页地址
- [x] 局域网 IP 选取和横幅文本生成是可单独测试的函数，有单元测试
- [x] `cargo test` 通过；`cargo build --release` 无新警告

## Comments

已实现，改动只在 `rustpad-server/src/main.rs`：

- `read_config()` 和 `start()` 把原来的三处 `expect` 与 `warp::serve(...).run()`
  换成返回中文错误；`main()`
  打印“启动失败：…”，有控制台时等待 Enter，然后以退出码1 退出。端口监听改用
  `try_bind_ephemeral`，端口被占用时返回错误而不是崩溃。
- `lan_ip()` 把 UDP 套接字 connect 到 `1.1.1.1:80`
  后读取本端地址，不发送数据包； `usable_lan_ip()`
  排除回环、未指定和链路本地地址。
- `startup_banner()` 生成横幅；`open_browser()` 只在 `cfg(windows)` 下调用
  `cmd /C start`。

验证（由运行器执行）：`cargo test -q -p rustpad-server`
全部通过，其中 3 个新单元测试； `cargo build -p rustpad-server`
无警告；把源码同步到 Windows 临时目录后，
`cargo.exe check -p rustpad-server --tests`
通过，sqlite 的 C 代码在 Windows 侧可以编译。 `cargo fmt --check` 无差异。

未验证：Windows 下自动打开浏览器、双击启动时出错后等待 Enter。这两项在 05 的 Windows 实机运行中检查，“只在 Windows 下打开浏览器”一项因此保持未勾选。
