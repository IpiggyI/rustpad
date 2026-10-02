# 01：服务端保存和提供图片

**What to build:**
服务端增加图片上传和读取两个接口，图片保存在 `IMAGE_DIR` 指定的目录里。接口形状、状态码、文件名格式和响应头见同目录
`spec.md` 的"服务端"一节，那一节是本票的约束。

**Blocked by:** 无

**Status:** ready-for-agent

- [x] `IMAGE_DIR` 未设置时，上传返回 503，读取返回 404
- [x] 上传 png、jpeg、gif、webp 成功，返回 `{"path":"api/images/<图片id>.<扩展名>"}`；之后用该地址读取，得到相同字节和正确的 `Content-Type`
- [x] 读取响应带 `X-Content-Type-Options: nosniff`
- [x] 格式按文件头判断：SVG、纯文本、伪装成 png 的其他内容返回 415
- [x] 超过 10 MiB 返回 413，目录里不留下文件
- [x] 不符合 `<图片id>.<扩展名>` 格式的文件名（含路径穿越）返回 404
- [x] 目录不存在时，第一次上传自动创建
- [x] 写文件不覆盖已有文件；没写完的文件不以最终文件名出现
- [x] 不删除图片这一简化带 `shortcut:` 标记
- [x] `README.md` 写明 `IMAGE_DIR`；开发用 `.env` 开启上传，开发时生成的图片目录加入 `.gitignore`
- [x] 服务端测试覆盖以上行为，至少一条在格式判断缺失时会失败

## Comments

实现由 Codex 车道完成：先由 `gpt-6-luna` 起步，运行被外部时限中断；再由 `gpt-6.1-sol` 接手完成（会话
`01a0fd48-15fd-7310-84e9-ef7395f28a3b`）。代码在 `rustpad-server/src/lib.rs`，测试在
`rustpad-server/tests/images.rs`。

验证：`cargo test -p rustpad-server` 退出码 0，`tests/images.rs` 10 项通过。格式判断测试用 SVG、纯文本、伪装的 png
上传并断言 415，去掉文件头判断会失败。

最终文件名用硬链接发布：先写完临时文件，再链接到最终名字，名字已存在时换 id 重试。FAT32、exFAT 不支持硬链接，在这类磁盘上上传会返回
500 并记录原因。Windows 上尚未实测，留到合并进 `intranet` 时验证。
