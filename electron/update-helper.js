/* ============================================================
 * 天天音乐 · 升级应用器（独立进程运行，不依赖 Electron API）
 * ------------------------------------------------------------
 * 由 electron/updater.js 在应用退出前用
 *   <产品名>.exe update-helper.js      （ELECTRON_RUN_AS_NODE=1）
 * 拉起，负责：
 *   1. 等主进程完全退出（文件锁释放）
 *   2. 把解压好的新版本覆盖到应用目录（带重试）
 *   3. 写升级结果（供新版启动后提示）
 *   4. 清理临时目录并重新启动应用
 * 配置全部通过环境变量传入：
 *   TT_UPDATE_PID / TT_UPDATE_TARGET / TT_UPDATE_STAGE /
 *   TT_UPDATE_EXE / TT_UPDATE_VERSION / TT_UPDATE_LOG / TT_UPDATE_RESULT
 * ============================================================ */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const zlib = require("zlib");

// 本进程用的是 Electron 的 exe（ELECTRON_RUN_AS_NODE），fs 仍带 asar 补丁：
// 复制 resources/app.asar 这种路径会被当成「打开压缩包」而报 Invalid package。
try { process.noAsar = true; } catch (e) {}

const CFG = {
  pid: parseInt(process.env.TT_UPDATE_PID || "0", 10) || 0,
  target: process.env.TT_UPDATE_TARGET || "",
  staging: process.env.TT_UPDATE_STAGE || "",
  exe: process.env.TT_UPDATE_EXE || "",
  version: process.env.TT_UPDATE_VERSION || "",
  log: process.env.TT_UPDATE_LOG || "",
  result: process.env.TT_UPDATE_RESULT || "",
  // 重启时带上原来的启动参数（例如双击文件打开的那个文件路径）
  args: (function () { try { const a = JSON.parse(process.env.TT_UPDATE_ARGS || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } })(),
};

function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg + "\r\n";
  try { fs.appendFileSync(CFG.log, line); } catch (e) {}
}

/* 同步等待：优先 Atomics.wait（不占 CPU），退化到忙等 */
const WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) {
  try { Atomics.wait(WAIT_BUF, 0, 0, ms); } catch (e) { const end = Date.now() + ms; while (Date.now() < end) {} }
}

/* 进程是否还活着：EPERM 视为活着（权限不足但进程存在） */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === "EPERM"); }
}

function writeResult(obj) {
  if (!CFG.result) { log("未配置结果路径，跳过回执"); return; }
  try {
    fs.mkdirSync(path.dirname(CFG.result), { recursive: true });
    fs.writeFileSync(CFG.result, JSON.stringify(obj), "utf8");
    log("回执已写入：" + CFG.result);
  } catch (e) { log("写结果失败：" + e.message); }
}

// 超过这个大小只比文件大小（逐个哈希 180MB 的 exe 没意义）
const BIG_FILE = 8 * 1024 * 1024;

/* 判断目标文件是否与升级包里的完全一致 —— 一致就跳过，别去碰正在被占用的 exe / dll */
function sameAs(srcPath, destPath) {
  let ss, ds;
  try { ss = fs.statSync(srcPath); } catch (e) { return false; }
  try { ds = fs.statSync(destPath); } catch (e) { return false; }
  if (!ds.isFile() || ss.size !== ds.size) return false;
  if (ss.size > BIG_FILE) return true;
  try {
    return zlib.crc32(fs.readFileSync(srcPath)) === zlib.crc32(fs.readFileSync(destPath));
  } catch (e) { return false; }
}

function copyTree(src, dest, out) {
  let items = [];
  try { items = fs.readdirSync(src, { withFileTypes: true }); }
  catch (e) { out.errors.push("读取 " + src + " 失败：" + (e.code || e.message)); return; }
  for (const it of items) {
    const s = path.join(src, it.name);
    const d = path.join(dest, it.name);
    if (it.isDirectory()) { copyTree(s, d, out); continue; }
    if (sameAs(s, d)) { out.skipped += 1; continue; }
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      try {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
        ok = true;
      } catch (e) {
        if (i === 4) out.errors.push(it.name + "：" + (e.code || e.message));
        else sleep(600);
      }
    }
    if (ok) out.copied += 1;
  }
}

function relaunch() {
  const exe = path.join(CFG.target, CFG.exe);
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;          // 关键：否则新进程会当 node 跑，界面起不来
  if (CFG.version) env.TT_UPDATED_TO = CFG.version;
  try {
    cp.spawn(exe, CFG.args, { detached: true, stdio: "ignore", cwd: CFG.target, env: env }).unref();
    log("已重新启动：" + exe + (CFG.args.length ? " " + CFG.args.join(" ") : ""));
    return true;
  } catch (e) {
    log("重新启动失败：" + e.message);
    return false;
  }
}

function main() {
  log("升级器启动 pid=" + CFG.pid + " 目标=" + CFG.target);
  if (!CFG.target || !CFG.staging || !CFG.exe) {
    log("配置不完整，放弃");
    writeResult({ ok: false, errors: ["升级器配置不完整"], version: CFG.version });
    return;
  }

  // 1) 等主进程退出
  const deadline = Date.now() + 90000;
  while (alive(CFG.pid) && Date.now() < deadline) sleep(400);
  if (alive(CFG.pid)) log("警告：主进程 90 秒内未退出，仍尝试替换（可能失败）");
  else log("主进程已退出");
  sleep(800);

  // 2) 校验升级包（完整包带 exe；只含 app.asar 的增量包也接受）
  const hasExe = fs.existsSync(path.join(CFG.staging, CFG.exe));
  const hasAsar = fs.existsSync(path.join(CFG.staging, "resources", "app.asar")) ||
    fs.existsSync(path.join(CFG.staging, "resources", "app.asar.unpacked"));
  if (!hasExe && !hasAsar) {
    log("升级包内容不完整，放弃");
    writeResult({ ok: false, errors: ["升级包内容不完整"], version: CFG.version });
    try { fs.rmSync(CFG.staging, { recursive: true, force: true }); } catch (e) {}
    relaunch();
    return;
  }

  // 3) 增量复制（逐文件比对，相同的直接跳过 —— 既不浪费时间，也不会去动被占用的 exe）
  const res = { copied: 0, skipped: 0, errors: [] };
  const copyDeadline = Date.now() + 45000;
  for (let round = 0; round < 20; round++) {
    res.copied = 0;
    res.skipped = 0;
    res.errors = [];
    copyTree(CFG.staging, CFG.target, res);
    if (!res.errors.length) break;
    if (Date.now() > copyDeadline) break;
    log("第 " + (round + 1) + " 轮：跳过 " + res.skipped + "，失败 " + res.errors.length + "（" + res.errors[0] + "），重试…");
    sleep(2000);
  }
  const ok = res.errors.length === 0;
  log(ok
    ? "替换完成：更新 " + res.copied + " 个文件，跳过未变化 " + res.skipped + " 个"
    : "替换失败（已更新 " + res.copied + " 个）：" + res.errors.slice(0, 5).join(" | "));
  writeResult({
    ok: ok, copied: res.copied, skipped: res.skipped,
    errors: res.errors.slice(0, 20), version: CFG.version, at: new Date().toISOString(),
  });

  // 4) 清理临时文件
  try { fs.rmSync(CFG.staging, { recursive: true, force: true }); } catch (e) {}

  // 5) 重新启动
  relaunch();
  log("升级器结束");
}

try { main(); }
catch (e) {
  log("升级器异常：" + (e && e.stack || e));
  writeResult({ ok: false, errors: [String(e && e.message || e)], version: CFG.version });
  relaunch();
}
