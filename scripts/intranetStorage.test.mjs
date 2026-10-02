import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const windows = process.platform === "win32";
const repo = fileURLToPath(new URL("../", import.meta.url));
const helper = join(repo, "scripts", "cleanup-intranet.ps1");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rustpad-storage-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workdir = join(root, "rustpad-intranet-check.12345678");
  mkdirSync(workdir);
  writeFileSync(join(workdir, "sentinel"), "temporary check data");
  return { root, workdir };
}

function clean(root, args) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", helper, "-TempRoot", root, ...args], { encoding: "utf8" });
}

function exitCheck(root, workdir, code) {
  const script = readFileSync(join(repo, "scripts/check-intranet-release.sh"), "utf8");
  const prefix = script.slice(0, script.indexOf("[[ $# -eq 1")).replace(/^root=.*$/m, 'root=""');
  assert.ok(prefix.includes("trap cleanup EXIT"));
  const body = `${prefix}\nroot=$(wslpath -u ${quote(repo)})\nwindows_temp=${quote(root)}\nworkdir=$(wslpath -u ${quote(workdir)})\nchecks_passed=true\nexit ${code}\n`;
  return spawnSync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-s"], { input: body, encoding: "utf8" });
}

for (const code of [0, 7]) {
  test(`release check removes its own directory on exit ${code}`, { skip: !windows }, (t) => {
    const { root, workdir } = fixture(t);
    const sibling = join(root, "rustpad-intranet-check.87654321");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "sentinel"), "another check");
    const result = exitCheck(root, workdir, code);
    assert.equal(result.status, code, result.stderr);
    assert.equal(existsSync(workdir), false, "exit cleanup must remove this check's directory");
    assert.equal(existsSync(join(sibling, "sentinel")), true, "another check must be retained");
  });
}

test("cleanup rejects a sibling outside its root", { skip: !windows }, (t) => {
  const { root, workdir } = fixture(t);
  const unrelatedRoot = join(root, "other-root");
  mkdirSync(unrelatedRoot);
  const result = clean(unrelatedRoot, ["-CheckDirectory", workdir]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(workdir, "sentinel")), true);
});

test("cleanup refuses junctions without traversing their target", { skip: !windows }, (t) => {
  const { root, workdir } = fixture(t);
  const other = join(root, "unrelated");
  mkdirSync(other);
  writeFileSync(join(other, "sentinel"), "keep");
  symlinkSync(other, join(workdir, "junction"), "junction");
  const result = clean(root, ["-CheckDirectory", workdir]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(other, "sentinel")), true);
  assert.equal(existsSync(join(workdir, "sentinel")), true);
});

test("explicit cache cleanup removes only the fixed build directory", { skip: !windows }, (t) => {
  const { root, workdir } = fixture(t);
  const cache = join(root, "rustpad-intranet-build");
  mkdirSync(cache);
  writeFileSync(join(cache, "object"), "build cache");
  const result = clean(root, ["-BuildCache"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(cache), false);
  assert.equal(existsSync(join(workdir, "sentinel")), true);
});

test("cleanup rejection prevents a successful release-check message", { skip: !windows }, (t) => {
  const { root, workdir } = fixture(t);
  const other = join(root, "unrelated");
  mkdirSync(other);
  symlinkSync(other, join(workdir, "junction"), "junction");
  const result = exitCheck(root, workdir, 0);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /发布检查通过/);
});

test("cache cleanup refuses a packaging lock and keeps the cache", { skip: !windows }, (t) => {
  const { root } = fixture(t);
  const cache = join(root, "rustpad-intranet-build");
  const lock = join(root, "rustpad-intranet-build.lock");
  mkdirSync(cache);
  writeFileSync(lock, "packaging lock");
  writeFileSync(join(cache, "object"), "in use");
  const result = clean(root, ["-BuildCache"]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(cache, "object")), true);
  assert.equal(existsSync(lock), true);
  const packageScript = readFileSync(join(repo, "scripts/package-intranet.sh"), "utf8");
  assert.match(packageScript, /build_lock="\$temp_dir\/rustpad-intranet-build\.lock"/);
  assert.match(packageScript, /set -o noclobber; : > "\$build_lock"/);
  assert.match(packageScript, /trap release_build_lock EXIT/);
});

test("cleanup retains a directory with a running executable", { skip: !windows }, async (t) => {
  const { root, workdir } = fixture(t);
  const executable = join(workdir, "ping.exe");
  copyFileSync(join(process.env.SystemRoot, "System32", "ping.exe"), executable);
  const child = spawn(executable, ["-t", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
  try {
    await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
    const result = clean(root, ["-CheckDirectory", workdir]);
    assert.equal(child.exitCode, null, "fixture process must remain running");
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(workdir, "sentinel")), true);
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise((done) => child.once("exit", done));
      spawnSync("taskkill.exe", ["/F", "/PID", String(child.pid)], { windowsHide: true });
      await stopped;
    }
  }
});
