/* ============================================================
 * 天天音乐 · 在线升级
 * ------------------------------------------------------------
 * 流程：检查 GitHub Release → 下载 win64 压缩包 → 校验（体积 / sha256）
 *      → 解压到临时目录 → 拉起 electron/update-helper.js 独立进程
 *      → 应用退出 → 升级器覆盖文件 → 重新启动 → 新版读回执提示
 *
 * 设计取舍：
 * - 绿色版 / 安装版统一处理：直接把包覆盖到「当前 exe 所在目录」。
 * - 不使用 electron-updater（体积大、要求 electron-builder 的 publish 配置、
 *   且只认 latest.yml）。这里用最少依赖走通同一条链路。
 * - 下载与 API 都先直连 GitHub，失败再依次尝试国内加速镜像。
 * ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const EL = (() => { try { return require("electron"); } catch (e) { return {}; } })();
// 注意：require("electron") 并不导出 spawn（那是 child_process 的），必须兜底，
// 否则升级器根本拉不起来 —— 表现为「点了升级却什么都没发生」。
const spawn = (EL && typeof EL.spawn === "function") ? EL.spawn : require("child_process").spawn;
const ZIP = require("./zipx");

const REPO = "wenwen-1982/tiantian-music";
const API_URL = "https://api.github.com/repos/" + REPO + "/releases/latest";
const PAGE_URL = "https://github.com/" + REPO + "/releases/latest";
// 第一个为空串 = 直连；后面是国内常用 GitHub 加速镜像（失败自动跳过）
const MIRRORS = ["", "https://ghfast.top/", "https://ghproxy.net/"];

// 自建 / 内网更新源：只有在进程环境里显式指定时才生效（渲染层无法设置环境变量）。
// 用途：企业内网分发、离线部署、自动化测试。
function apiUrl() { return process.env.TT_UPDATE_API || API_URL; }
function customHost() {
  try { return new URL(process.env.TT_UPDATE_API || "").hostname.toLowerCase(); } catch (e) { return ""; }
}
function isGithubHost(h) {
  return h === "github.com" || h === "api.github.com" || /\.githubusercontent\.com$/.test(h);
}
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ""; } }
const UA = {
  "User-Agent": "TianTianMusic-Updater/1.0 (+https://github.com/" + REPO + ")",
  "Accept": "application/vnd.github+json",
};

/* ---------------- 版本号 ---------------- */
function normVersion(v) {
  const s = String(v == null ? "" : v).trim();
  const m = s.match(/v?(\d+(?:\.\d+)*)(?:[-+][0-9A-Za-z.\-]+)?/);
  return m ? m[1] : s.replace(/^v/i, "");
}
function suffix(v) {
  const s = String(v == null ? "" : v).trim();
  const m = s.match(/[-+]([0-9A-Za-z.\-]+)$/);
  return m ? m[1] : "";
}
/** a>b → 1；a<b → -1；相等 → 0 */
function cmpVersion(a, b) {
  const pa = normVersion(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = normVersion(b).split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  const sa = suffix(a), sb = suffix(b);
  if (sa === sb) return 0;
  if (!sa) return 1;      // 正式版 > 预发布版
  if (!sb) return -1;
  return sa > sb ? 1 : -1;
}

function currentVersion() {
  try { if (EL.app) return EL.app.getVersion(); } catch (e) {}
  try { return require("../package.json").version; } catch (e) {}
  return "0.0.0";
}
function exePath() {
  try { if (EL.app) return EL.app.getPath("exe"); } catch (e) {}
  return process.execPath;
}
function sourceDir() { return path.dirname(exePath()); }
function dataDir() {
  try { if (EL.app) { const v = EL.app.getPath("userData"); if (v) return v; } } catch (e) {}
  const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "tiantian-music");
}
function tempRoot() { return path.join(os.tmpdir(), "tt-update"); }
function resultPath() { return path.join(dataDir(), "update-result.json"); }

/* ---------------- HTTP ---------------- */
function pickMod(u) { return u.protocol === "http:" ? http : https; }

function fetchBuffer(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("链接无效")); }
    const req = pickMod(u).get(u, { headers: Object.assign({}, UA, opts.headers || {}), timeout: opts.timeout || 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchBuffer(new URL(res.headers.location, u).toString(), opts));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error("HTTP " + res.statusCode);
        err.status = res.statusCode;
        if (res.statusCode === 403 && res.headers["x-ratelimit-remaining"] === "0") {
          err.message = "GitHub 访问过于频繁（403），请稍后再试";
        }
        if (res.statusCode === 404) err.message = "没有找到发布信息（404）";
        return reject(err);
      }
      const chunks = [];
      let total = 0;
      res.on("data", (c) => {
        total += c.length;
        if (opts.maxBytes && total > opts.maxBytes) { req.destroy(new Error("响应过大")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on("timeout", () => req.destroy(new Error("网络超时")));
    req.on("error", reject);
  });
}

/* 流式下载到文件（带进度），返回 {size, sha256} */
function downloadTo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("下载链接无效")); }
    const req = pickMod(u).get(u, { headers: Object.assign({}, UA), timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadTo(new URL(res.headers.location, u).toString(), dest, onProgress));
      }
      if (res.statusCode !== 200) { res.resume(); const e = new Error("HTTP " + res.statusCode); e.status = res.statusCode; return reject(e); }
      const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
      const tmp = dest + ".part";
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(tmp);
      let received = 0;
      res.on("data", (c) => {
        received += c.length;
        hash.update(c);
        if (onProgress) onProgress({ received: received, total: total });
      });
      res.on("end", () => {});
      res.pipe(out);
      out.on("finish", () => {
        try { fs.rmSync(dest, { force: true }); fs.renameSync(tmp, dest); } catch (e) { return reject(e); }
        resolve({ size: received, sha256: hash.digest("hex") });
      });
      out.on("error", reject);
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("下载超时，请检查网络")));
    req.on("error", reject);
  });
}

/* ---------------- 选择下载附件 ---------------- */
function pickAsset(assets) {
  const list = (assets || []).filter((a) => a && a.name && a.browser_download_url);
  const byRe = (re) => list.find((a) => re.test(a.name));
  return byRe(/win64.*\.zip$/i) || byRe(/\.zip$/i) || byRe(/win64.*\.exe$/i) ||
    list.find((a) => /\.exe$/i.test(a.name)) || null;
}

/* ---------------- 检查更新 ---------------- */
async function check(opts) {
  opts = opts || {};
  const cur = opts.current || currentVersion();
  let lastErr = null;
  const base = apiUrl();
  const mirrors = isGithubHost(hostOf(base)) ? MIRRORS : [""];   // 自建源不走加速镜像
  for (const m of mirrors) {
    const url = m ? m + base : base;
    try {
      const r = await fetchBuffer(url, { timeout: 12000 });
      const j = JSON.parse(r.body.toString("utf8"));
      const tag = String(j.tag_name || j.name || "").trim();
      const latest = normVersion(tag);
      if (!latest) throw new Error("发布信息中没有版本号");
      const asset = pickAsset(j.assets);
      return {
        ok: true, current: cur, latest: latest, tag: tag || ("v" + latest),
        hasUpdate: cmpVersion(latest, cur) > 0,
        notes: String(j.body || "").slice(0, 8000),
        releaseName: String(j.name || ""),
        publishedAt: String(j.published_at || ""),
        asset: asset ? {
          name: asset.name, size: asset.size || 0,
          url: asset.browser_download_url, digest: asset.digest || "",
        } : null,
        pageUrl: PAGE_URL, mirror: m || "direct",
      };
    } catch (e) {
      lastErr = e;
      if (e && e.status === 404) break;    // 仓库/发布不存在，换镜像也没用
    }
  }
  return {
    ok: false, current: cur, pageUrl: PAGE_URL,
    error: (lastErr && lastErr.message) || "检查更新失败", rate: (lastErr && lastErr.status) || 0,
  };
}

/* 只允许从 GitHub 官方域名（或显式配置的自建源）取包，避免渲染层传入任意地址 */
function assertGithubUrl(u) {
  const h = hostOf(u);
  if (!h) throw new Error("升级包地址不合法");
  if (isGithubHost(h)) return;
  const ch = customHost();
  if (ch && h === ch) return;
  throw new Error("升级包地址不合法：" + h);
}

/* ---------------- 下载升级包 ---------------- */
async function download(asset, onProgress) {
  if (!asset || !asset.url) throw new Error("没有可用的升级包");
  assertGithubUrl(asset.url);
  if (asset.name && /[\\/]/.test(asset.name)) throw new Error("升级包文件名不合法");
  const dir = tempRoot();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.name);
  let lastErr = null;
  const mirrors = isGithubHost(hostOf(asset.url)) ? MIRRORS : [""];
  for (const m of mirrors) {
    const url = m ? m + asset.url : asset.url;
    try {
      const r = await downloadTo(url, dest, onProgress);
      if (asset.size && r.size !== asset.size) throw new Error("下载不完整（" + r.size + "/" + asset.size + "）");
      if (asset.digest && /^sha256:/i.test(asset.digest)) {
        const want = asset.digest.split(":")[1].toLowerCase();
        if (want && want !== r.sha256.toLowerCase()) throw new Error("校验失败：下载文件与官方摘要不一致");
      }
      return { path: dest, size: r.size, sha256: r.sha256, mirror: m || "direct" };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error((lastErr && lastErr.message) || "下载失败");
}

/* ---------------- 校验 + 应用 ---------------- */
/* 升级包可能有两种形态：完整便携包（含 exe）或只含 resources/app.asar 的增量包。
 * 目录结构可能是「条目直接在根」也可能是「外面包一层文件夹」，两种都认。 */
function looksLikePackage(dir, exeName) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch (e) { return false; }
  return fs.existsSync(path.join(dir, exeName)) ||
    fs.existsSync(path.join(dir, "resources", "app.asar")) ||
    fs.existsSync(path.join(dir, "resources", "app.asar.unpacked"));
}
function findPackageRoot(root, exeName) {
  if (looksLikePackage(root, exeName)) return root;
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const sub = path.join(root, it.name);
    if (looksLikePackage(sub, exeName)) return sub;
  }
  return null;
}

/* 主进程里同步小睡（等待升级器启动，只用在退出前的最后一刻） */
const WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepBusy(ms) {
  try { Atomics.wait(WAIT_BUF, 0, 0, ms); } catch (e) { const end = Date.now() + ms; while (Date.now() < end) {} }
}

function cleanOldStages() {
  const root = tempRoot();
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  const now = Date.now();
  for (const it of items) {
    if (!it.isDirectory() || !/^stage-/.test(it.name)) continue;
    const full = path.join(root, it.name);
    try { if (now - fs.statSync(full).mtimeMs > 86400000) fs.rmSync(full, { recursive: true, force: true }); } catch (e) {}
  }
}

/* 把升级器脚本复制到临时目录（asar 内的文件不能被独立进程直接跑） */
function helperToTemp() {
  const src = path.join(__dirname, "update-helper.js");
  const dest = path.join(tempRoot(), "update-helper-" + Date.now() + ".js");
  fs.mkdirSync(tempRoot(), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src));
  return dest;
}

function fallbackScript(target, staging, exeName, logFile, pid, args) {
  // 兜底方案：exe 无法以 Node 模式启动时，用 .cmd + xcopy 完成替换
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "setlocal enabledelayedexpansion",
    "set n=0",
    ":wait",
    "tasklist /FI \"PID eq " + pid + "\" /NH /FO CSV 2>nul | findstr /C:\"" + pid + "\" >nul",
    "if not errorlevel 1 (",
    "  set /a n+=1",
    "  if !n! LSS 90 ( timeout /t 1 /nobreak >nul & goto wait )",
    ")",
    "timeout /t 2 /nobreak >nul",
    "xcopy \"" + staging + "\\*\" \"" + target + "\\\" /E /Y /I /Q /R >nul 2>&1",
    "if errorlevel 1 robocopy \"" + staging + "\" \"" + target + "\" /E /IS /IT /NFL /NDL /NJH /NJS /R:3 /W:1 >nul",
    "echo done >> \"" + logFile + "\"",
    "rd /s /q \"" + staging + "\" >nul 2>&1",
    "start \"\" \"" + path.join(target, exeName) + "\"" + (args && args.length ? " " + args.map((a) => '"' + String(a) + '"').join(" ") : ""),
    "del \"%~f0\" >nul 2>&1",
  ];
  return lines.join("\r\n") + "\r\n";
}

/**
 * 下载完成后：解压 + 拉起升级器
 * @param {{zipPath:string, version:string, target?:string, onProgress?:Function}} o
 */
function apply(o) {
  const onProgress = o.onProgress || function () {};
  const target = o.target || sourceDir();
  const exeName = path.basename(exePath());
  const logFile = path.join(tempRoot(), "apply.log");
  const result = resultPath();

  onProgress({ phase: "extract", current: 0, total: 1, text: "正在解压…" });
  const staging = path.join(tempRoot(), "stage-" + Date.now());
  fs.rmSync(staging, { recursive: true, force: true });
  const res = ZIP.extract(o.zipPath, staging, (p) => {
    onProgress({ phase: "extract", current: p.current, total: p.total, file: p.file, text: "正在解压…" });
  });

  const root = findPackageRoot(staging, exeName);
  if (!root) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) {}
    throw new Error("升级包内容不完整（既没有 " + exeName + " 也没有 resources/app.asar）");
  }

  // 记录本次升级信息，重启后新版会读到
  try {
    fs.writeFileSync(logFile, "");
  } catch (e) {}

  // 重启时沿用原来的启动参数（双击文件打开的场景能回到同一个文件）
  const relaunchArgs = process.argv.slice(1).filter((a) => typeof a === "string" && a.indexOf("--remote-debugging-pipe") < 0);

  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: "1",
    TT_UPDATE_ARGS: JSON.stringify(relaunchArgs),
    TT_UPDATE_PID: String(process.pid),
    TT_UPDATE_TARGET: target,
    TT_UPDATE_STAGE: root,
    TT_UPDATE_EXE: exeName,
    TT_UPDATE_VERSION: String(o.version || ""),
    TT_UPDATE_LOG: logFile,
    TT_UPDATE_RESULT: result,
  });

  let launched = "";
  try {
    const helper = helperToTemp();
    const child = spawn(exePath(), [helper], { detached: true, stdio: "ignore", windowsHide: true, env: env });
    child.unref();
    // 等升级器写下第一行日志，确认它真的跑起来了（Electron 冷启动约 0.3~1s）
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      try { if (fs.statSync(logFile).size > 0) { launched = "node"; break; } } catch (e) {}
      sleepBusy(120);
    }
  } catch (e) {
    launched = "";
  }

  // 兜底：升级器没起来就写 .cmd（xcopy 覆盖后重启）
  if (!launched) {
    const cmd = path.join(tempRoot(), "update-" + Date.now() + ".cmd");
    const script = fallbackScript(target, root, exeName, logFile, process.pid, relaunchArgs);
    fs.writeFileSync(cmd, "\uFEFF" + script, "utf8");
    spawn("explorer.exe", [cmd], { detached: true, stdio: "ignore" }).unref();
    launched = "cmd";
  }

  onProgress({ phase: "apply", current: 1, total: 1, text: "升级包已就绪，正在重启完成升级…" });
  return { ok: true, staging: root, target: target, exeName: exeName, files: res.files, via: launched, version: o.version || "" };
}

/* ---------------- 上次升级结果回执 ---------------- */
function takeResult() {
  const p = resultPath();
  try {
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    fs.rmSync(p, { force: true });
    return j;
  } catch (e) { return null; }
}

module.exports = {
  check, download, apply, takeResult,
  cmpVersion, normVersion, pickAsset, sourceDir, exePath, dataDir,
  currentVersion, tempRoot, resultPath, cleanOldStages, REPO, PAGE_URL,
};
