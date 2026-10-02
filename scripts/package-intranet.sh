#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
step="检查构建环境"
trap 'status=$?; printf "打包失败：%s（退出码 %s）。\n" "$step" "$status" >&2' ERR

run_step() {
  step=$1
  shift
  printf '%s\n' "$step" >&2
  "$@"
}

if [[ ! -d node_modules ]]; then
  printf '打包失败：缺少 node_modules，请先安装项目依赖。\n' >&2
  exit 1
fi

run_step "构建 wasm" wasm-pack build rustpad-wasm --no-opt
run_step "检查前端" npm run check
run_step "构建前端" npm run build

step="读取 Windows 临时目录"
cmd_dir=$(dirname "$(command -v cmd.exe)")
windows_temp=$( (cd "$cmd_dir" && cmd.exe /C 'echo %TEMP%') | tr -d '\r' | tail -n 1)
[[ -n "$windows_temp" && "$windows_temp" != '%TEMP%' ]]
temp_dir=$(wslpath -u "$windows_temp")
build_dir="$temp_dir/rustpad-intranet-build"
build_lock="$temp_dir/rustpad-intranet-build.lock"
if ! (set -o noclobber; : > "$build_lock") 2>/dev/null; then
  printf '打包失败：Windows 编译缓存正在使用，或上次中断留下锁文件：%s\n' "$build_lock" >&2
  exit 1
fi
release_build_lock() {
  local status=$?
  if ! rm -- "$build_lock"; then
    printf '无法释放编译缓存锁：%s\n' "$build_lock" >&2
    [[ "$status" -ne 0 ]] || status=1
  fi
  exit "$status"
}
trap release_build_lock EXIT
mkdir -p "$build_dir"

step="查找 Windows cargo.exe"
if [[ -n "${CARGO_EXE:-}" ]]; then
  cargo_exe=$CARGO_EXE
else
  user_profile=$( (cd "$cmd_dir" && cmd.exe /C 'echo %USERPROFILE%') | tr -d '\r' | tail -n 1)
  [[ -n "$user_profile" && "$user_profile" != '%USERPROFILE%' ]]
  cargo_exe="$(wslpath -u "$user_profile")/.cargo/bin/cargo.exe"
fi
[[ -f "$cargo_exe" ]]

step="复制服务端源码到 Windows 临时目录"
command -v rsync >/dev/null
cp Cargo.toml Cargo.lock "$build_dir/"
mkdir -p "$build_dir/rustpad-server" "$build_dir/rustpad-wasm"
rsync -a --delete --exclude /target/ "$root/rustpad-server/" "$build_dir/rustpad-server/"
rsync -a --delete --exclude /target/ --exclude /pkg/ "$root/rustpad-wasm/" "$build_dir/rustpad-wasm/"

run_step "编译 Windows x64 服务端" bash -c 'cd "$1" && "$2" build --release --target x86_64-pc-windows-msvc -p rustpad-server' _ "$build_dir" "$cargo_exe"

step="生成 Windows 发布压缩包"
exe="$build_dir/target/x86_64-pc-windows-msvc/release/rustpad-server.exe"
[[ -f "$exe" && -f dist/index.html ]]
mkdir -p release
zip_path="$root/release/rustpad-intranet-windows-x64-$(date +%Y%m%d)-$(git rev-parse --short HEAD).zip"
python3 - "$zip_path" "$exe" "$root/dist" "$root/packaging/intranet" <<'PY'
import pathlib
import sys
import zipfile

archive, exe, dist, templates = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
    output.write(exe, "rustpad.exe")
    output.writestr("dist/", b"")
    for source in sorted(dist.rglob("*")):
        if source.is_file():
            output.write(source, source.relative_to(dist.parent).as_posix())
    output.write(templates / ".env", ".env")
    instructions = (templates / "使用说明.txt").read_text(encoding="utf-8-sig")
    instructions = instructions.replace("\r\n", "\n").replace("\r", "\n")
    output.writestr("使用说明.txt", b"\xef\xbb\xbf" + instructions.replace("\n", "\r\n").encode("utf-8"))
PY

printf '%s\n' "$zip_path"
