#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
step="检查参数"
workdir=""
current_pid=""
launcher_pid=""
checks_passed=false
trap 'status=$?; printf "发布检查失败：%s（退出码 %s）。\n" "$step" "$status" >&2' ERR

cleanup() {
  local status=$?
  trap - EXIT ERR
  if [[ -n "$current_pid" ]]; then
    taskkill.exe /F /PID "$current_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$workdir" ]]; then
    for pid_file in "$workdir"/rustpad-*.pid; do
      [[ -f "$pid_file" ]] || continue
      taskkill.exe /F /PID "$(<"$pid_file")" >/dev/null 2>&1 || true
    done
  fi
  if [[ -n "$launcher_pid" ]]; then
    kill "$launcher_pid" 2>/dev/null || true
    wait "$launcher_pid" 2>/dev/null || true
  fi
  if [[ -n "$workdir" ]]; then
    local cleanup_script cleanup_dir
    cleanup_script=$(wslpath -w "$root/scripts/cleanup-intranet.ps1")
    cleanup_dir=$(wslpath -w "$workdir")
    if ! powershell.exe -NoProfile -NonInteractive -File "$cleanup_script" \
      -CheckDirectory "$cleanup_dir" -TempRoot "$windows_temp"; then
      printf '临时目录清理失败，已保留：%s\n' "$workdir" >&2
      [[ "$status" -ne 0 ]] || status=1
    fi
  fi
  if [[ "$status" -eq 0 && "$checks_passed" == true ]]; then
    printf '发布检查通过：Windows 启动、离线资源、持久化重启、图片上传与重启后读取和 BOM 配置。\n'
  fi
  exit "$status"
}
trap cleanup EXIT

[[ $# -eq 1 && -f "$1" ]]
archive=$(realpath "$1")
if curl --silent --output /dev/null --max-time 2 http://127.0.0.1:3030/api/stats; then
  printf '发布检查拒绝运行：127.0.0.1:3030 已有服务响应。\n' >&2
  exit 1
fi

step="读取 Windows 临时目录"
cmd_dir=$(dirname "$(command -v cmd.exe)")
windows_temp=$( (cd "$cmd_dir" && cmd.exe /C 'echo %TEMP%') | tr -d '\r' | tail -n 1)
[[ -n "$windows_temp" && "$windows_temp" != '%TEMP%' ]]
temp_dir=$(wslpath -u "$windows_temp")
workdir=$(mktemp -d "$temp_dir/rustpad-intranet-check.XXXXXXXX")

ps_quote() {
  local value=${1//\'/\'\'}
  printf "'%s'" "$value"
}

step="用 PowerShell 解压发布包"
archive_win=$(wslpath -w "$archive")
workdir_win=$(wslpath -w "$workdir")
powershell.exe -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath $(ps_quote "$archive_win") -DestinationPath $(ps_quote "$workdir_win") -Force" >/dev/null

step="检查压缩包内容"
python3 - "$archive" "$workdir" <<'PY'
import pathlib
import sys
import zipfile

archive, directory = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(archive) as source:
    names = source.namelist()
    top = {name.split("/", 1)[0] for name in names}
    assert top == {"rustpad.exe", "dist", ".env", "使用说明.txt"}, top
    assert "使用说明.txt" in names
    assert source.getinfo("使用说明.txt").flag_bits & 0x800
for name in ("rustpad.exe", "dist/index.html", ".env", "使用说明.txt"):
    assert (directory / name).is_file(), name
PY

step="检查压缩包图片配置"
python3 - "$archive" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as source:
    assert "IMAGE_DIR=images" in source.read(".env").decode("utf-8-sig").splitlines()
PY

start_server() {
  local attempt=$1
  local exe_win out_win err_win pid_win
  step="启动 Windows 服务端（第 $attempt 次）"
  exe_win=$(wslpath -w "$workdir/rustpad.exe")
  out_win=$(wslpath -w "$workdir/rustpad-$attempt.stdout.log")
  err_win=$(wslpath -w "$workdir/rustpad-$attempt.stderr.log")
  pid_win=$(wslpath -w "$workdir/rustpad-$attempt.pid")
  powershell.exe -NoProfile -NonInteractive -Command "\$ErrorActionPreference = 'Stop'; try { \$p = Start-Process -FilePath $(ps_quote "$exe_win") -WorkingDirectory $(ps_quote "$workdir_win") -RedirectStandardOutput $(ps_quote "$out_win") -RedirectStandardError $(ps_quote "$err_win") -PassThru; \$p.Id | Out-File -FilePath $(ps_quote "$pid_win") -Encoding ascii } catch { if (\$p) { Stop-Process -Id \$p.Id -Force }; throw }" >"$workdir/rustpad-$attempt.launcher.log" 2>&1 &
  launcher_pid=$!
  for ((i = 0; i < 40; i++)); do
    [[ -s "$workdir/rustpad-$attempt.pid" ]] && break
    if ! kill -0 "$launcher_pid" 2>/dev/null; then
      cat "$workdir/rustpad-$attempt.launcher.log" >&2
      return 1
    fi
    sleep 0.25
  done
  [[ -s "$workdir/rustpad-$attempt.pid" ]]
  current_pid=$(tr -d '\r\n ' < "$workdir/rustpad-$attempt.pid")
  [[ "$current_pid" =~ ^[0-9]+$ ]]

  step="等待 Windows 服务端就绪（第 $attempt 次）"
  for ((i = 0; i < 120; i++)); do
    if curl --fail --silent --output /dev/null --max-time 2 http://127.0.0.1:3030/api/stats; then
      return
    fi
    sleep 0.5
  done
  return 1
}

check_banner() {
  local attempt=$1
  step="检查启动横幅（第 $attempt 次）"
  local log="$workdir/rustpad-$attempt.stdout.log"
  grep -q '访问地址：http://' "$log"
  grep -q '数据位置（SQLITE_URI）：sqlite://rustpad.db' "$log"
  grep -q '图片位置（IMAGE_DIR）：images' "$log"
  ! grep -q '未开启持久化' "$log"
  ! grep -q '图片上传未开启' "$log"
  ! grep -q '找不到 dist/index.html' "$log"
}

stop_server() {
  step="停止 Windows 服务端"
  taskkill.exe /F /PID "$current_pid" >/dev/null
  current_pid=""
  if [[ -n "$launcher_pid" ]]; then
    kill "$launcher_pid" 2>/dev/null || true
    wait "$launcher_pid" 2>/dev/null || true
    launcher_pid=""
  fi
  for ((i = 0; i < 40; i++)); do
    if ! curl --silent --output /dev/null --max-time 1 http://127.0.0.1:3030/api/stats; then
      return
    fi
    sleep 0.25
  done
  return 1
}

check_image() {
  local attempt=$1
  step="检查图片读回字节、类型与重复上传复用（第 $attempt 次）"
  python3 - "$workdir" <<'PY'
import json
import pathlib
import sys
import urllib.request

directory = pathlib.Path(sys.argv[1])
path = (directory / "uploaded-image.path").read_text(encoding="utf-8")
with urllib.request.urlopen(f"http://127.0.0.1:3030/{path}", timeout=5) as response:
    assert response.status == 200, response.status
    assert response.headers["Content-Type"] == "image/png", response.headers
    assert response.read() == (directory / "upload.png").read_bytes()
request = urllib.request.Request("http://127.0.0.1:3030/api/images",
                                 data=(directory / "upload.png").read_bytes(), method="POST")
image_count = len(list((directory / "images").glob("*.png")))
with urllib.request.urlopen(request, timeout=5) as response:
    assert response.status == 200, response.status
    assert json.load(response)["path"] == path
assert len(list((directory / "images").glob("*.png"))) == image_count
PY
}

start_server 1
check_banner 1

step="上传 PNG 图片"
python3 - "$workdir" <<'PY'
import json
import pathlib
import re
import struct
import sys
import urllib.request
import zlib

directory = pathlib.Path(sys.argv[1])
def chunk(kind, data):
    return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))
png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack("!2I5B", 1, 1, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff"))
       + chunk(b"IEND", b""))
(directory / "upload.png").write_bytes(png)
request = urllib.request.Request("http://127.0.0.1:3030/api/images", data=png, method="POST")
with urllib.request.urlopen(request, timeout=5) as response:
    assert response.status == 200, response.status
    path = json.load(response)["path"]
assert re.fullmatch(r"api/images/[0-9]{8}-[a-z0-9]{4}\.png", path), path
(directory / "uploaded-image.path").write_text(path, encoding="utf-8")
PY
check_image 1

step="检查图片保存在程序旁的 images 文件夹"
image_path=$(<"$workdir/uploaded-image.path")
[[ -f "$workdir/images/${image_path##*/}" ]]
cmp "$workdir/upload.png" "$workdir/images/${image_path##*/}"

step="检查前端资源不访问外部地址"
(cd "$root" && RUSTPAD_DIST_URL=http://127.0.0.1:3030 node scripts/offlineAssets.browser.mjs)

step="检查图片粘贴、删除后重贴、撤销重做与多人同步"
(cd "$root" && RUSTPAD_URL=http://127.0.0.1:3030 node scripts/imagePaste.browser.mjs)

step="在浏览器写入单文档"
doc_id="release$(date +%s%N)"
marker="rustpad-intranet-$(date +%s%N)"
(cd "$root" && node --input-type=module - "$doc_id" "$marker" <<'JS'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright-core");

const [id, marker] = process.argv.slice(2);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--no-proxy-server"],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:3030/#${id}`);
  await page.getByText("You are connected!", { exact: true }).waitFor();
  await page.waitForFunction(() => (window.monaco?.editor.getEditors().length ?? 0) > 0);
  await page.evaluate((value) => {
    const editor = window.monaco.editor.getEditors()[0];
    editor.executeEdits("release-check", [{ range: editor.getModel().getFullModelRange(), text: value }]);
  }, marker);
  await page.waitForFunction(async ({ id, marker }) => {
    const response = await fetch(`/api/text/${id}`);
    return (await response.text()).includes(marker);
  }, { id, marker });
  await new Promise((resolve) => setTimeout(resolve, 5000));
} finally {
  await browser.close();
}
JS
)

stop_server
start_server 2
check_banner 2
check_image 2
step="检查重启后的文档和数据库"
python3 - "$doc_id" "$marker" "$workdir/rustpad.db" <<'PY'
import pathlib
import sys
import urllib.request

doc_id, marker, database = sys.argv[1:]
assert marker in urllib.request.urlopen(f"http://127.0.0.1:3030/api/text/{doc_id}", timeout=5).read().decode()
assert pathlib.Path(database).is_file()
PY

stop_server
step="模拟记事本保存带 BOM 和 CRLF 的配置"
python3 - "$workdir/.env" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
lines = path.read_text(encoding="utf-8-sig").splitlines()
path.write_bytes(b"\xef\xbb\xbf" + ("\r\n".join(lines) + "\r\n").encode("utf-8"))
PY

start_server 3
check_banner 3
step="检查 BOM 配置仍开启持久化"
[[ -f "$workdir/rustpad.db" ]]
stop_server
checks_passed=true
