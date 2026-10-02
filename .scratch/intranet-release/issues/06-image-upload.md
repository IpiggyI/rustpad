# 06: 内网版开启图片上传

**What to build:** 把 main 上的图片功能（见 `.scratch/image-paste/spec.md` 和
[ADR 0007](../../../docs/adr/0007-images-on-server-disk-referenced-by-relative-path.md)）带进内网版：双击运行后默认开启上传，图片保存在程序所在文件夹的
`images` 文件夹里。main 已在 `38071e0` 合并进本分支，合并时只给 `start()` 里的 `ServerConfig` 补上了 `image_dir`。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] 打包用的 `.env` 写入 `IMAGE_DIR=images`，带一行中文注释，风格与其他三项一致
- [ ] 启动横幅显示图片位置（`IMAGE_DIR`）；未设置时提示图片上传未开启，风格与"数据位置（SQLITE_URI）"一行一致
- [ ] `使用说明.txt` 的备份和恢复说明同时包括 `rustpad.db` 和 `images` 文件夹；如写到添加图片的方法，按钮名与界面一致
- [ ] `imagePaste.browser.mjs`、`imagePreview.browser.mjs` 中断言 Monaco 来自 CDN 的检查，改成本分支其他浏览器测试的"不访问外部地址"检查
- [ ] 发布检查脚本：确认 zip 里的 `.env` 含 `IMAGE_DIR=images`；横幅含图片位置；在 Windows 服务端上传一张 png 并读回相同字节；重启后仍能读回；`images` 文件夹位于程序所在文件夹
- [ ] `cargo test`、类型检查、前端单元测试通过
- [ ] 打包并在 Windows 主机上跑通发布检查
- [ ] 实机验证：主机和手机上粘贴、选图、预览、点击打开原图

## Comments
