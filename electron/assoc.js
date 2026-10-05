/* 文件关联（Windows）
 * ------------------------------------------------------------------
 * 全部写入 HKCU（当前用户），不需要管理员权限。
 *
 * Windows 10 1903+ 起，程序不能静默夺取某个扩展名的默认归属
 * （UserChoice 有哈希校验），标准做法是：
 *   1) 注册 ProgId + OpenWithProgids  -> 出现在「打开方式」列表
 *   2) 注册 Applications\<exe>\Capabilities + RegisteredApplications
 *      -> 出现在「设置 → 默认应用」的选择列表里，用户一键设为默认
 *   3) 对当前还没有默认程序的扩展名，直接接管（HKCU 的 .ext 默认值）
 *
 * 注册表写入走 PowerShell 的 .NET Registry API（非 COM，稳定）；
 * 若 PowerShell 不可用，退化为生成 .reg 文件让用户确认导入。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const APP_ID = "TianTianMusic";
const APP_NAME = "天天音乐";
const PROG_ID = "TianTianMusic.MediaFile";

const AUDIO_EXTS = ["mp3", "flac", "m4a", "wav", "ogg", "aac", "opus", "wma"];
const VIDEO_EXTS = ["mp4", "webm", "mkv", "mov", "m4v", "avi", "flv", "wmv", "mpg", "mpeg", "ts", "3gp", "rmvb", "rm", "vob", "asf", "ogv", "m2ts"];
const ALL_EXTS = AUDIO_EXTS.concat(VIDEO_EXTS);

/* ---------------- 构造注册表变更 ---------------- */
// 返回 { set: [{key, name, kind, data}], delKeys: [], delValues: [{key, name}] }
function buildEntries(exePath, exts) {
  const list = (exts && exts.length ? exts : ALL_EXTS).map((e) => String(e).replace(/^\./, "").toLowerCase());
  const exeName = path.basename(exePath);
  const cmd = '"' + exePath + '" "%1"';
  const icon = '"' + exePath + '",0';
  const appKey = "Software\\Classes\\Applications\\" + exeName;

  const set = [];
  const S = (key, name, data) => set.push({ key: "HKEY_CURRENT_USER\\" + key, name: name || "", kind: "String", data });
  const N = (key, name) => set.push({ key: "HKEY_CURRENT_USER\\" + key, name, kind: "None", data: null });
  const D = (key, name, data) => set.push({ key: "HKEY_CURRENT_USER\\" + key, name, kind: "DWord", data });

  // ProgId
  S("Software\\Classes\\" + PROG_ID, "", APP_NAME + " 媒体文件");
  S("Software\\Classes\\" + PROG_ID, "FriendlyTypeName", APP_NAME);
  S("Software\\Classes\\" + PROG_ID + "\\DefaultIcon", "", icon);
  S("Software\\Classes\\" + PROG_ID + "\\shell\\open\\command", "", cmd);
  S("Software\\Classes\\" + PROG_ID + "\\shell\\open", "FriendlyAppName", APP_NAME);

  // Applications\<exe>：让「打开方式」里显示本应用
  S(appKey, "", APP_NAME);
  S(appKey, "FriendlyAppName", APP_NAME);
  S(appKey + "\\DefaultIcon", "", icon);
  S(appKey + "\\shell\\open\\command", "", cmd);
  S(appKey + "\\Capabilities", "ApplicationName", APP_NAME);
  S(appKey + "\\Capabilities", "ApplicationDescription", "本地音乐 + 视频播放器（支持 avi / wmv / flv 等老格式）");
  for (const e of list) S(appKey + "\\Capabilities\\FileAssociations", "." + e, PROG_ID);

  // 每个扩展名：登记为「可用打开方式」+ 声明支持的媒体类型
  for (const e of list) {
    N("Software\\Classes\\." + e + "\\OpenWithProgids", PROG_ID);
    S("Software\\Classes\\." + e + "\\OpenWithList", exeName, "");
    // 直接设默认值：只有当用户从未在系统设置里选过默认程序时才会生效
    // （UserChoice 优先级更高，所以不会抢走用户已有的选择）
    S("Software\\Classes\\." + e, "", PROG_ID);
  }

  // RegisteredApplications：出现在 Windows「默认应用」设置页
  S("Software\\RegisteredApplications", APP_ID, appKey + "\\Capabilities");

  return { set, delKeys: [], delValues: [] };
}

/* 卸载时的清理项 */
function buildRemoval(exePath, exts) {
  const list = (exts && exts.length ? exts : ALL_EXTS).map((e) => String(e).replace(/^\./, "").toLowerCase());
  const exeName = path.basename(exePath);
  const delKeys = [
    "Software\\Classes\\" + PROG_ID,
    "Software\\Classes\\Applications\\" + exeName,
  ];
  const delValues = [{ key: "Software\\RegisteredApplications", name: APP_ID }];
  // 条件清理：只有当前归属是本应用时才动，避免破坏用户自己的设置
  const cond = [];
  for (const e of list) {
    delValues.push({ key: "Software\\Classes\\." + e + "\\OpenWithProgids", name: PROG_ID });
    delValues.push({ key: "Software\\Classes\\." + e + "\\OpenWithList", name: exeName });
    // 默认 ProgId 若指向本应用则清空，交还系统
    cond.push({ key: "Software\\Classes\\." + e, name: "", equals: PROG_ID, action: "clearValue" });
    // 系统设置里选的默认若是本应用，删掉 UserChoice 让系统回到默认
    cond.push({ key: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\." + e + "\\UserChoice", name: "ProgId", equals: PROG_ID, action: "deleteKey" });
  }
  return { set: [], delKeys, delValues, cond };
}

/* ---------------- 写入通道 ---------------- */
function tmpFile(ext) { return path.join(os.tmpdir(), "tt_reg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) + ext); }

function psEscape(s) { return String(s).replace(/'/g, "''"); }

function psScript(plan) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$plan = Get-Content -Raw -Encoding UTF8 '" + psEscape(plan.jsonPath) + "' | ConvertFrom-Json",
    "foreach ($e in @($plan.set)) {",
    "  $kind = [Microsoft.Win32.RegistryValueKind]::($e.kind)",
    "  $data = $e.data",
    "  if ($e.kind -eq 'None') { $data = [byte[]]::new(0) }",
    "  if ($e.kind -eq 'DWord') { $data = [int]$e.data }",
    "  [Microsoft.Win32.Registry]::SetValue($e.key, [string]$e.name, $data, $kind)",
    "}",
    "foreach ($k in @($plan.delValues)) {",
    "  Remove-ItemProperty -Path ('HKCU:\\' + $k.key) -Name $k.name -Force -ErrorAction SilentlyContinue",
    "}",
    "foreach ($k in @($plan.delKeys)) {",
    "  Remove-Item -Path ('HKCU:\\' + $k) -Recurse -Force -ErrorAction SilentlyContinue",
    "}",
    "foreach ($c in @($plan.cond)) {",
    "  $cur = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\\' + $c.key, [string]$c.name, $null)",
    "  if ($cur -eq $c.equals) {",
    "    if ($c.action -eq 'deleteKey') { Remove-Item -Path ('HKCU:\\' + $c.key) -Recurse -Force -ErrorAction SilentlyContinue }",
    "    else { [Microsoft.Win32.Registry]::SetValue('HKEY_CURRENT_USER\\' + $c.key, [string]$c.name, '', [Microsoft.Win32.RegistryValueKind]::String) }",
    "  }",
    "}",
    "Write-Output 'REG_OK'",
  ].join("\r\n");
}

/* 执行计划；返回 {ok, error} */
function apply(plan) {
  const jsonPath = tmpFile(".json");
  const psPath = tmpFile(".ps1");
  try {
    fs.writeFileSync(jsonPath, JSON.stringify({
      set: plan.set || [], delKeys: plan.delKeys || [], delValues: plan.delValues || [], cond: plan.cond || [],
    }), "utf8");
    // BOM 让 PowerShell 正确识别中文
    fs.writeFileSync(psPath, "\uFEFF" + psScript({ jsonPath }), "utf8");
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psPath],
      { encoding: "utf8", windowsHide: true, timeout: 60000 });
    if (r.status === 0 && /REG_OK/.test(r.stdout || "")) return { ok: true };
    return { ok: false, error: ((r.stderr || "") + (r.stdout || "")).trim().slice(0, 500) || "PowerShell 执行失败" };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    try { fs.unlinkSync(jsonPath); } catch (e) {}
    try { fs.unlinkSync(psPath); } catch (e) {}
  }
}

/* 查询某扩展名当前的默认打开命令（用于判断要不要接管、以及回显状态） */
function queryDefaultCommand(ext) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$prog = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\\Software\\Classes\\." + ext + "\\UserChoice', 'ProgId', $null)",
    "if (-not $prog) { $prog = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\\Software\\Classes\\." + ext + "', '', $null) }",
    "if (-not $prog) { $prog = [Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\\Software\\Classes\\." + ext + "', '', $null) }",
    "if (-not $prog) { Write-Output '' ; exit }",
    "$cmd = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\\Software\\Classes\\' + $prog + '\\shell\\open\\command', '', $null)",
    "if (-not $cmd) { $cmd = [Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\\Software\\Classes\\' + $prog + '\\shell\\open\\command', '', $null) }",
    "Write-Output ([string]$cmd)",
  ].join("\r\n");
  const p = tmpFile(".ps1");
  try {
    fs.writeFileSync(p, "\uFEFF" + ps, "utf8");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", p],
      { encoding: "utf8", windowsHide: true, timeout: 30000 });
    return ((r.stdout || "").trim() || "");
  } catch (e) {
    return "";
  } finally { try { fs.unlinkSync(p); } catch (e) {} }
}

/* 回退通道：生成 .reg 文本（PowerShell 不可用时让用户手动导入） */
function toRegText(plan) {
  const out = ["Windows Registry Editor Version 5.00", ""];
  const seen = new Set();
  (plan.set || []).forEach((e) => {
    const key = e.key.replace(/^HKEY_CURRENT_USER\\/, "");
    if (!seen.has(key)) { seen.add(key); out.push("[HKEY_CURRENT_USER\\" + key + "]"); }
    const name = e.name === "" ? "@" : '"' + e.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    let val;
    if (e.kind === "DWord") val = "dword:" + ("00000000" + (e.data >>> 0).toString(16)).slice(-8);
    else if (e.kind === "None") val = "hex(0):";
    else val = '"' + String(e.data).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    out.push(name + "=" + val);
  });
  (plan.delValues || []).forEach((v) => {
    out.push("[HKEY_CURRENT_USER\\" + v.key + "]");
    out.push('"' + v.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"=-');
  });
  (plan.delKeys || []).forEach((k) => out.push("[-HKEY_CURRENT_USER\\" + k + "]"));
  out.push("");
  return out.join("\r\n");
}

module.exports = {
  APP_ID, APP_NAME, PROG_ID, AUDIO_EXTS, VIDEO_EXTS, ALL_EXTS,
  buildEntries, buildRemoval, apply, queryDefaultCommand, toRegText,
};
