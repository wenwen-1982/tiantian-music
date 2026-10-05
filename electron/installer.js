/* 安装 / 卸载（Windows，当前用户级，无需管理员权限）
 * ------------------------------------------------------------------
 * - 安装：把当前运行的整个应用目录复制到安装目录
 *         （默认 %LOCALAPPDATA%\Programs\天天音乐）
 *         写文件关联、卸载项、开始菜单 / 桌面快捷方式
 * - 卸载：清注册表、删快捷方式、延迟删除安装目录
 * 快捷方式优先用 PowerShell 的 WScript.Shell，失败则退化为手写 .lnk 二进制。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, shell, spawn } = (() => { try { return require("electron"); } catch (e) { return {}; } })();
const A = require("./assoc");

const APP_ID = "TianTianMusic";
const APP_NAME = "天天音乐";
const UNINSTALL_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + APP_ID;
const SETTINGS_KEY = "Software\\" + APP_ID;

/* 系统目录（某些环境 app.getPath 会失败，统一带环境变量 / 家目录回退） */
function localAppData() {
  try { const v = app.getPath("localAppData"); if (v) return v; } catch (e) {}
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}
function roamingAppData() {
  try { const v = app.getPath("appData"); if (v) return v; } catch (e) {}
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}
function desktopDir() {
  try { const v = app.getPath("desktop"); if (v) return v; } catch (e) {}
  return path.join(os.homedir(), "Desktop");
}
function dataDir() {
  try { const v = app.getPath("userData"); if (v) return v; } catch (e) {}
  return path.join(localAppData(), APP_NAME + "-data");
}

function exePath() { try { return app.getPath("exe"); } catch (e) { return process.execPath; } }
function sourceDir() { return path.dirname(exePath()); }
function defaultDir() { return path.join(localAppData(), "Programs", APP_NAME); }
function version() { try { return app.getVersion(); } catch (e) { return "1.3.0"; } }

/* ---------------- 已安装信息 ---------------- */
function installMarkerPath() { return path.join(dataDir(), "install-path.txt"); }
function readInstallDir() {
  try {
    const p = installMarkerPath();
    if (fs.existsSync(p)) {
      const d = fs.readFileSync(p, "utf8").trim();
      if (d && fs.existsSync(path.join(d, path.basename(exePath())))) return d;
    }
  } catch (e) {}
  return null;
}
function writeInstallDir(dir) {
  try {
    const p = installMarkerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, dir, "utf8");
  } catch (e) {}
}

function defaults() {
  const inst = readInstallDir();
  return {
    version: version(),
    exePath: exePath(),
    sourceDir: sourceDir(),
    suggestedDir: inst || defaultDir(),
    installedDir: inst,
    isInstalled: !!inst,
    audioExts: A.AUDIO_EXTS,
    videoExts: A.VIDEO_EXTS,
  };
}

/* ---------------- 文件复制 ---------------- */
// Electron 自带的示例应用，不需要跟着复制
const SKIP_FILES = /\\resources\\default_app\.asar$/i;

function listFiles(root) {
  const out = [];
  (function walk(dir) {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (SKIP_FILES.test(full)) continue;
      if (it.isDirectory()) walk(full);
      else out.push(full);
    }
  })(root);
  return out;
}

function copyTree(src, dest, onProgress) {
  const files = listFiles(src);
  const failures = [];
  let done = 0;
  for (const f of files) {
    const rel = path.relative(src, f);
    const to = path.join(dest, rel);
    let ok = true;
    for (let attempt = 0; attempt < 3 && ok; attempt++) {
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(f, to);
        ok = false;
      } catch (e) {
        if (attempt === 2) { failures.push(rel + " (" + (e.code || e.message) + ")"); ok = false; }
        else { const wait = Date.now() + 400; while (Date.now() < wait) {} }
      }
    }
    done += 1;
    onProgress && onProgress({ current: done, total: files.length, file: rel });
  }
  copyTree.failures = failures;
  return files.length;
}

/* ---------------- 快捷方式 ---------------- */
function makeLnkBuffer(target, args, workDir, icon, desc) {
  const flags = 0x00000002 /* HasLinkInfo */ | 0x00000004 /* HasName */ | 0x00000008 /* HasRelativePath */
    | 0x00000010 /* HasWorkingDir */ | 0x00000020 /* HasArguments */ | 0x00000040 /* HasIconLocation */
    | 0x00000080 /* IsUnicode */ | 0x00000001 /* HasLinkTargetIDList */;
  const CLSID = Buffer.from([0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]);
  const head = Buffer.alloc(0x4c);
  head.writeUInt32LE(0x4c, 0);
  CLSID.copy(head, 4);
  head.writeUInt32LE(flags, 20);
  head.writeUInt32LE(0x20 /* FILE_ATTRIBUTE_ARCHIVE */, 24);
  // 时间字段留 0 即可
  head.writeUInt32LE(0, 32); // IconIndex
  head.writeUInt32LE(1, 36); // ShowCommand = SW_SHOWNORMAL
  head.writeUInt16LE(0, 40); head.writeUInt16LE(0, 42); head.writeUInt32LE(0, 44); head.writeUInt32LE(0, 48);

  // 空 IDList（仅终止符）
  const idList = Buffer.alloc(4); idList.writeUInt16LE(2, 0); idList.writeUInt16LE(0, 2);

  // LinkInfo
  const basePath = Buffer.from(target, "ascii");
  const suffix = Buffer.from([0x00]);
  const linkInfoSize = 0x1c + basePath.length + 1 + suffix.length;
  const li = Buffer.alloc(linkInfoSize);
  li.writeUInt32LE(linkInfoSize, 0);
  li.writeUInt32LE(0x1c, 4);
  li.writeUInt32LE(0, 8);                        // flags: 无 VolumeID
  li.writeUInt32LE(0, 12);                       // VolumeIDOffset
  li.writeUInt32LE(0x1c, 16);                    // LocalBasePathOffset
  li.writeUInt32LE(0, 20);                       // CommonNetworkRelativeLinkOffset
  li.writeUInt32LE(0x1c + basePath.length + 1, 24); // CommonPathSuffixOffset
  basePath.copy(li, 0x1c); li[0x1c + basePath.length] = 0;
  suffix.copy(li, linkInfoSize - 1);

  // StringData（Unicode：2 字节字符数 + UTF-16LE，末尾不补 \0）
  const u = (s) => {
    const b = Buffer.from(String(s || ""), "utf16le");
    const n = Buffer.alloc(2); n.writeUInt16LE(b.length / 2, 0);
    return Buffer.concat([n, b]);
  };
  const strings = Buffer.concat([
    u(desc || APP_NAME), u(path.basename(target)), u(workDir || ""), u(args || ""), u(icon || target),
  ]);

  const terminal = Buffer.alloc(4);
  return Buffer.concat([head, idList, li, strings, terminal]);
}

function createShortcut(lnkPath, target, args, workDir, desc) {
  const icon = target;
  // 1) PowerShell（标准做法，图标与描述完整）
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$s = New-Object -ComObject WScript.Shell",
    "$l = $s.CreateShortcut('" + lnkPath.replace(/'/g, "''") + "')",
    "$l.TargetPath = '" + target.replace(/'/g, "''") + "'",
    "$l.Arguments = '" + String(args || "").replace(/'/g, "''") + "'",
    "$l.WorkingDirectory = '" + String(workDir || "").replace(/'/g, "''") + "'",
    "$l.IconLocation = '" + (icon + ",0").replace(/'/g, "''") + "'",
    "$l.Description = '" + String(desc || APP_NAME).replace(/'/g, "''") + "'",
    "$l.Save()",
    "if (Test-Path '" + lnkPath.replace(/'/g, "''") + "') { Write-Output 'LNK_OK' }",
  ].join("\r\n");
  const p = path.join(os.tmpdir(), "tt_lnk_" + Date.now() + ".ps1");
  try {
    fs.writeFileSync(p, "\uFEFF" + ps, "utf8");
    const { spawnSync } = require("child_process");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", p],
      { encoding: "utf8", windowsHide: true, timeout: 30000 });
    if (r.status === 0 && /LNK_OK/.test(r.stdout || "")) { fs.unlinkSync(p); return { ok: true, via: "powershell" }; }
  } catch (e) {} finally { try { fs.unlinkSync(p); } catch (e) {} }
  // 2) 手写 .lnk 二进制
  try {
    fs.mkdirSync(path.dirname(lnkPath), { recursive: true });
    fs.writeFileSync(lnkPath, makeLnkBuffer(target, args, workDir, icon, desc));
    return { ok: true, via: "binary" };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ---------------- 安装 ---------------- */
function install(opts, onProgress) {
  const dir = (opts && opts.dir) || defaultDir();
  const src = sourceDir();
  const self = path.basename(exePath());
  const sameDir = path.resolve(dir) === path.resolve(src);
  const exts = (opts && opts.exts && opts.exts.length) ? opts.exts : A.ALL_EXTS;
  const steps = [];

  if (!sameDir) {
    onProgress && onProgress({ phase: "copy", current: 0, total: 1 });
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    // Electron 会给 fs 打 asar 补丁，主进程里直接复制 app.asar 会报 ENOENT。
    // 官方开关 process.noAsar 可以临时关掉该补丁，让 asar 变回普通文件。
    const prevNoAsar = process.noAsar;
    process.noAsar = true;
    try {
      copyTree(src, dir, (p) => onProgress && onProgress({ phase: "copy", current: p.current, total: p.total, file: p.file }));
    } finally {
      process.noAsar = prevNoAsar;
    }
  } else {
    onProgress && onProgress({ phase: "copy", current: 1, total: 1, skipped: true });
  }
  const installedExe = path.join(dir, self);
  steps.push("文件已就位：" + installedExe);

  // 记录安装位置（userData 跨版本保留，便于升级覆盖与卸载定位）
  writeInstallDir(dir);

  // 文件关联
  onProgress && onProgress({ phase: "assoc", current: 1, total: 3 });
  const plan = A.buildEntries(installedExe, exts);
  const appReg = plan.set.concat([
    { key: "HKEY_CURRENT_USER\\" + SETTINGS_KEY, name: "InstallDir", kind: "String", data: dir },
    { key: "HKEY_CURRENT_USER\\" + SETTINGS_KEY, name: "Version", kind: "String", data: String(version()) },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "DisplayName", kind: "String", data: APP_NAME + " " + version() },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "DisplayVersion", kind: "String", data: String(version()) },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "Publisher", kind: "String", data: "wenwen-1982" },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "InstallLocation", kind: "String", data: dir },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "DisplayIcon", kind: "String", data: '"' + installedExe + '",0' },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "UninstallString", kind: "String", data: '"' + installedExe + '" --uninstall' },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "QuietUninstallString", kind: "String", data: '"' + installedExe + '" --uninstall' },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "NoModify", kind: "DWord", data: 1 },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "NoRepair", kind: "DWord", data: 1 },
    { key: "HKEY_CURRENT_USER\\" + UNINSTALL_KEY, name: "HelpLink", kind: "String", data: "https://github.com/wenwen-1982/tiantian-music" },
  ]);
  const r = A.apply(Object.assign({}, plan, { set: appReg }));
  steps.push(r.ok ? "文件关联已写入" : "文件关联写入失败：" + r.error);

  // 快捷方式
  onProgress && onProgress({ phase: "shortcut", current: 2, total: 3 });
  const sm = path.join(roamingAppData(), "Microsoft\\Windows\\Start Menu\\Programs", APP_NAME);
  try { fs.mkdirSync(sm, { recursive: true }); } catch (e) {}
  const s1 = createShortcut(path.join(sm, APP_NAME + ".lnk"), installedExe, "", dir, "天天音乐 · 本地音乐与视频播放器");
  const s2 = createShortcut(path.join(sm, "卸载 " + APP_NAME + ".lnk"), installedExe, "--uninstall", dir, "卸载天天音乐");
  let s3 = { ok: false };
  if (opts && opts.desktopShortcut) {
    s3 = createShortcut(path.join(desktopDir(), APP_NAME + ".lnk"), installedExe, "", dir, "天天音乐 · 本地音乐与视频播放器");
  }
  steps.push("开始菜单快捷方式：" + (s1.ok ? "已创建" : "失败") + (s3.ok ? "，桌面快捷方式：已创建" : ""));

  onProgress && onProgress({ phase: "done", current: 3, total: 3 });
  return {
    ok: true,
    dir,
    exePath: installedExe,
    assocOk: !!r.ok,
    assocError: r.ok ? "" : r.error,
    shortcuts: { startMenu: s1.ok, startMenuUninstall: s2.ok, desktop: !!s3.ok, via: s1.via || s2.via || "" },
    copyFailures: copyTree.failures || [],
    steps,
  };
}

/* ---------------- 卸载 ---------------- */
function removeDirs(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

function uninstall() {
  const dir = readInstallDir() || defaultDir();
  const self = path.basename(exePath());
  const exts = A.ALL_EXTS;
  const steps = [];

  // 1) 清注册表（关联 + 卸载项 + 设置）
  const plan = A.buildRemoval(path.join(dir, self), exts);
  const extra = {
    delKeys: plan.delKeys.concat([UNINSTALL_KEY, SETTINGS_KEY]),
    delValues: plan.delValues,
    set: [],
  };
  const r = A.apply(extra);
  steps.push(r.ok ? "注册表已清理" : "注册表清理失败：" + r.error);

  // 2) 删快捷方式
  try {
    const sm = path.join(roamingAppData(), "Microsoft\\Windows\\Start Menu\\Programs", APP_NAME);
    removeDirs(sm);
    try { fs.unlinkSync(path.join(desktopDir(), APP_NAME + ".lnk")); } catch (e) {}
    steps.push("快捷方式已删除");
  } catch (e) { steps.push("快捷方式删除失败：" + e.message); }

  // 3) 删除安装目录（自身正在运行，交给延迟脚本）
  try { fs.unlinkSync(installMarkerPath()); } catch (e) {}
  const bat = path.join(os.tmpdir(), "tt_uninstall_" + Date.now() + ".cmd");
  const script = [
    "@echo off",
    "for /L %%i in (1,1,12) do (",
    "  rd /s /q \"" + dir + "\" >nul 2>&1",
    "  if not exist \"" + dir + "\\\\\" goto done",
    "  timeout /t 1 /nobreak >nul",
    ")",
    ":done",
    "del \"%~f0\" >nul 2>&1",
  ].join("\r\n");
  try {
    fs.writeFileSync(bat, script, "ascii");
    spawn("explorer.exe", [bat], { detached: true, stdio: "ignore" }).unref();
    steps.push("安装目录将在退出后删除");
  } catch (e) {
    steps.push("无法自动删除安装目录，请手动删除：" + dir);
  }
  return { ok: true, dir, steps, needQuit: true };
}

/* ---------------- 打开系统「默认应用」设置 ---------------- */
function openDefaultApps() {
  // Win10/11：打开本应用的默认应用设置页；失败则退到通用默认应用页
  const uri = "ms-settings:defaultapps?registeredAppId=" + APP_ID;
  if (shell && shell.openExternal) {
    shell.openExternal(uri).catch ? shell.openExternal(uri).catch(() => shell.openExternal("ms-settings:defaultapps")) : null;
    return true;
  }
  return false;
}

module.exports = { defaults, install, uninstall, openDefaultApps, defaultDir, readInstallDir, createShortcut };
