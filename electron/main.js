const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// 部分显卡/虚拟机环境下 GPU 进程不可用，禁用硬件加速以保证可启动
app.disableHardwareAcceleration();

let win = null;
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" };

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 760, minWidth: 980, minHeight: 620,
    backgroundColor: "#1c1d28", frame: false, show: false,
    title: "天天音乐",
    icon: path.join(__dirname, "../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
      webSecurity: false,          // 允许播放本地 file:// 音频 / 调用开放接口
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "../index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

/* ---------------- 窗口控制 ---------------- */
ipcMain.on("tt-win", (e, action) => {
  if (!win) return;
  if (action === "min") win.minimize();
  else if (action === "max") win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === "close") win.close();
});

/* ---------------- 目录 ---------------- */
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }

ipcMain.handle("tt-default-dir", () => {
  const d = path.join(app.getPath("music"), "天天音乐下载");
  ensureDir(d);
  return d;
});
ipcMain.handle("tt-choose-dir", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on("tt-open-path", (e, p) => { if (p) shell.openPath(p); });

/* ---------------- 文件选择 / 目录扫描 ---------------- */
const AUDIO_RE = /\.(mp3|flac|m4a|wav|ogg|aac|opus)$/i;
const VIDEO_RE = /\.(mp4|webm|mkv|mov|m4v|avi|flv|wmv|mpg|mpeg|ts|3gp)$/i;
function toFileUrl(p) {
  let u = p.replace(/\\/g, "/");
  if (!u.startsWith("/")) u = "/" + u;
  return "file://" + u.split("/").map(encodeURIComponent).join("/").replace(/%3A/g, ":");
}
function fileEntry(p) {
  let size = 0;
  try { size = fs.statSync(p).size; } catch (e) {}
  return { path: p, name: path.basename(p), url: toFileUrl(p), size };
}
function pickDialog(title, filters) {
  return dialog.showOpenDialog(win, { title, properties: ["openFile", "multiSelections"], filters });
}
// 递归收集目录下匹配的文件
function walkCollect(root, re, limit, depthMax) {
  const out = [];
  (function walk(dir, depth) {
    if (depth > (depthMax || 6) || out.length > (limit || 2000)) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (re.test(it.name)) out.push(fileEntry(full));
    }
  })(root, 0);
  return out;
}

ipcMain.handle("tt-pick-files", async () => {
  const r = await pickDialog("选择音频文件", [{ name: "音频文件", extensions: ["mp3", "flac", "m4a", "wav", "ogg", "aac", "opus"] }]);
  if (r.canceled) return [];
  return r.filePaths.map(fileEntry);
});

ipcMain.handle("tt-pick-videos", async () => {
  const r = await pickDialog("选择视频文件", [{ name: "视频文件", extensions: ["mp4", "webm", "mkv", "mov", "m4v", "avi", "flv", "wmv", "mpg", "mpeg", "ts", "3gp"] }]);
  if (r.canceled) return [];
  return r.filePaths.map(fileEntry);
});

ipcMain.handle("tt-scan-dir", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "选择要扫描的音乐目录" });
  if (r.canceled) return [];
  return walkCollect(r.filePaths[0], AUDIO_RE, 2000);
});

ipcMain.handle("tt-scan-video-dir", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "选择要扫描的视频目录" });
  if (r.canceled) return [];
  return walkCollect(r.filePaths[0], VIDEO_RE, 2000);
});

/* ---------------- 下载（带进度） ---------------- */
function streamDownload(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("链接无效")); }
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(u, { headers: Object.assign({ Referer: "https://ccmixter.org/" }, UA), timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(streamDownload(new URL(res.headers.location, u).toString(), dest, onProgress));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
      const tmp = dest + ".part";
      const out = fs.createWriteStream(tmp);
      let received = 0;
      res.on("data", (c) => { received += c.length; onProgress && onProgress(received, total); });
      res.pipe(out);
      out.on("finish", () => { try { fs.renameSync(tmp, dest); } catch (e) { return reject(e); } resolve({ size: received }); });
      out.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", reject);
  });
}

ipcMain.handle("tt-download", async (e, job) => {
  try {
    let dir = job.saveDir;
    if (!dir) { dir = path.join(app.getPath("music"), "天天音乐下载"); ensureDir(dir); }
    const safe = String(job.title || "audio").replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);
    const artist = job.artist ? " - " + String(job.artist).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) : "";
    const dest = path.join(dir, safe + artist + (job.ext || ".mp3"));
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { ok: true, file: path.basename(dest), skipped: true };
    const r = await streamDownload(job.url, dest, (received, total) => {
      if (win) win.webContents.send("tt-progress", { received, total });
    });
    return { ok: true, file: path.basename(dest), size: r.size };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
