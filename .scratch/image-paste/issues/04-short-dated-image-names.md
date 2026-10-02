# 04：图片名改为日期加短随机串

**What to build:**
新上传的图片名改为 `<YYYYMMDD>-<4 位小写字母或数字>.<扩展名>`，日期用上传者的本地日期。规则见同目录 `spec.md`
"服务端"一节中图片 id 的说明，那一条是本票的约束。

**Blocked by:** 无

**Status:** ready-for-agent

- [x] 前端上传时附带查询参数 `date=<上传者本地日期 YYYYMMDD>`
- [x] 服务端只接受恰好 8 位 ASCII 数字且是真实日历日期的 `date`（含闰年判断）；其他情况用 UTC 日期
- [x] 新图片名符合 `^\d{8}-[a-z0-9]{4}\.(png|jpg|gif|webp)$`；名字已存在时换随机部分重试，不覆盖
- [x] 早期的 32 位 id 仍能读取、被识别为链接、显示预览
- [x] 不符合两种格式的名字（含前后多余的 `-`、路径穿越）仍返回 404，也不被识别为图片引用
- [x] 服务端测试和浏览器测试按新格式更新，不放宽成任意字符

## Comments

实现由 Codex 车道 `gpt-6.1-sol` 完成（会话 `01a0fd4f-a093-7fd0-aab4-104e41b559a6`）。前端上传附带 `date`
参数；服务端严格校验日期，非法时用 UTC 日期。图片名格式定义在 `src/imageNames.ts` 和 `rustpad-server/src/lib.rs`。旧的 32 位 id
仍能读取、链接和预览，浏览器测试 `legacy 32-character image names still link and preview` 覆盖。
