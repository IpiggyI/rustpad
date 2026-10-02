# 06: 内网版开启图片上传

**What to build:** 把 main 上的图片功能（见 `.scratch/image-paste/spec.md` 和
[ADR 0007](../../../docs/adr/0007-images-on-server-disk-referenced-by-relative-path.md)）带进内网版：双击运行后默认开启上传，图片保存在程序所在文件夹的
`images` 文件夹里。main 已在 `38071e0` 合并进本分支，合并时只给 `start()` 里的 `ServerConfig` 补上了 `image_dir`。

**Blocked by:** 05

**Status:** ready-for-human

- [x] 打包用的 `.env` 写入 `IMAGE_DIR=images`，带一行中文注释，风格与其他三项一致
- [x] 启动横幅显示图片位置（`IMAGE_DIR`）；未设置时提示图片上传未开启，风格与"数据位置（SQLITE_URI）"一行一致
- [x] `使用说明.txt` 的备份和恢复说明同时包括 `rustpad.db` 和 `images` 文件夹；如写到添加图片的方法，按钮名与界面一致
- [x] `imagePaste.browser.mjs`、`imagePreview.browser.mjs` 中断言 Monaco 来自 CDN 的检查，改成本分支其他浏览器测试的"不访问外部地址"检查
- [x] 发布检查脚本：确认 zip 里的 `.env` 含 `IMAGE_DIR=images`；横幅含图片位置；在 Windows 服务端上传一张 png 并读回相同字节；重启后仍能读回；`images` 文件夹位于程序所在文件夹
- [x] `cargo test`、类型检查、前端单元测试通过
- [x] 打包并在 Windows 主机上跑通发布检查
- [ ] 实机验证：主机和手机上粘贴、选图、预览、点击打开原图

## Comments

实现由 Codex 车道 `gpt-6.1-sol` 完成（会话 `01a0fd96-4744-7451-be49-7ee2714fdb84`），提交 `1f40e20`。

验证：`cargo test -p rustpad-server`、`npm run check`、`npm test`（252 项）通过。`scripts/package-intranet.sh` 生成
`release/rustpad-intranet-windows-x64-20261003-1f40e20.zip`；`scripts/check-intranet-release.sh`
对该包退出码 0，在 Windows 主机上完成上传 PNG、读回相同字节、确认文件落在 `images` 文件夹、重启后再读回，NTFS 上的硬链接发布可用。在本分支代码上
`imagePaste.browser.mjs` 10 项、`imagePreview.browser.mjs` 18 项通过。

发布检查会在 Windows 主机上启动 `rustpad.exe` 三次，每次都会自动打开浏览器。

实机验证留给人工：主机和手机上的粘贴、选图、预览、点击打开原图。

合并 main 的第三期改动（`5be8ead`：带日期的图片名、只有图片本身可点击、预览可收起）后，发布检查里对上传结果的断言改成新名字格式
`api/images/<8 位数字>-<4 位小写字母或数字>.png`，由同一会话完成。合并后的 `cargo test -p rustpad-server`、`npm run check`、`npm test`（258 项）通过。
`scripts/package-intranet.sh` 生成 `release/rustpad-intranet-windows-x64-20261003-df5b5b6.zip`。对该包运行
`scripts/check-intranet-release.sh` 时，脚本文件在运行中途被本次改动以外的未提交修改改写，输出里出现了新版脚本才有的清理信息，所以这次的退出码 0
不能作为该包的验证结果。随后用当时工作区里的脚本重跑（含那些未提交的临时目录清理改动），运行前后脚本的
SHA-256 一致，退出码 0，上传的 PNG 按新格式命名。在本分支代码上 `imagePaste.browser.mjs` 和 `imagePreview.browser.mjs` 共 34 项通过，没有失败项。
