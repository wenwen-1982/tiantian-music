/* ============================================================
 * 老格式视频转码（avi / wmv / flv / rmvb / mpg 等）
 * Chromium 只内置 H.264 / VP8 / VP9 / AV1 / Theora 解码器，
 * 且不认 avi、flv、asf 容器。这里统一用 ffmpeg 转成 mp4：
 *   1) 先试 -c copy（只换容器，秒级、无损）
 *   2) 失败再转码 libx264 + aac
 * 结果按「路径 + 大小 + 修改时间」缓存到系统临时目录。
 * ============================================================ */
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

const TRANSCODE_RE = /\.(avi|wmv|flv|f4v|swf|rm|rmvb|mpg|mpeg|mpe|m1v|m2v|vob|asf|3gp|3g2|mts|m2ts|ts|dat|ogv)$/i;
const MAX_MS = 20 * 60 * 1000;

let cachedFfmpeg = null;

/* 查找 ffmpeg：发布包 resources/ → 项目根 → 项目 build/ → 系统 PATH */
function findFfmpeg() {
  if (cachedFfmpeg) return cachedFfmpeg;
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, "ffmpeg.exe"));
  try {
    const ap = app.getAppPath();
    cands.push(path.join(ap, "ffmpeg.exe"));
    cands.push(path.join(path.dirname(ap), "ffmpeg.exe"));
    cands.push(path.join(ap, "build", "ffmpeg.exe"));
  } catch (e) {}
  cands.push(path.join(__dirname, "..", "ffmpeg.exe"));
  cands.push(path.join(__dirname, "..", "build", "ffmpeg.exe"));
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) { cachedFfmpeg = c; return c; } } catch (e) {}
  }
  try {
    const out = execSync("where ffmpeg", { windowsHide: true, timeout: 6000 }).toString().split(/\r?\n/)[0].trim();
    if (out && fs.existsSync(out)) { cachedFfmpeg = out; return out; }
  } catch (e) {}
  return null;
}

function hasFfmpeg() { return !!findFfmpeg(); }

/* 从 ffmpeg -i 的 stderr 里读时长 */
function probeDuration(ff, file) {
  return new Promise((resolve) => {
    let err = "";
    let p;
    try { p = spawn(ff, ["-hide_banner", "-i", file], { windowsHide: true }); }
    catch (e) { return resolve(0); }
    p.stderr.on("data", (d) => { if (err.length < 200000) err += d.toString(); });
    p.on("error", () => resolve(0));
    p.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(err);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0);
    });
  });
}

const OUT_RE = /out_time_ms=(\d+)/;

/* 执行一条 ffmpeg 命令，解析 -progress 输出 */
function run(ff, args, duration, onPct) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(ff, args, { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: String(e && e.message || e) }); }
    let buf = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { p.kill(); } catch (e) {} }, MAX_MS);
    const feed = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const ln of lines) {
        const m = OUT_RE.exec(ln);
        if (m && duration > 0 && onPct) {
          const pct = Math.max(0, Math.min(99, Math.round((parseInt(m[1], 10) / 1000 / duration) * 100)));
          onPct(pct);
        }
      }
    };
    if (p.stdout) p.stdout.on("data", feed);
    if (p.stderr) p.stderr.on("data", () => {});
    p.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e && e.message || e) }); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return resolve({ ok: false, error: "转码超时（超过 20 分钟）" });
      resolve({ ok: code === 0, code: code });
    });
  });
}

const inflight = new Map();

async function transcode(file, onProgress) {
  const ff = findFfmpeg();
  if (!ff) return { ok: false, error: "未找到 ffmpeg.exe（发布包内应位于安装目录 resources 下）" };
  if (!file) return { ok: false, error: "文件路径为空" };
  let src = file;
  if (/^file:\/\/\//i.test(src)) {
    src = decodeURIComponent(src.replace(/^file:\/\//i, "")).replace(/^\//, "");
  }
  let st;
  try { st = fs.statSync(src); } catch (e) { return { ok: false, error: "文件不存在或无法读取" }; }

  const key = crypto.createHash("md5")
    .update(src + "|" + st.size + "|" + Math.floor(st.mtimeMs || 0)).digest("hex");
  const dir = path.join(app.getPath("temp"), "tiantian-music-transcode");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const out = path.join(dir, key + ".mp4");
  const done = path.join(dir, key + ".done");

  if (fs.existsSync(done) && fs.existsSync(out)) {
    return { ok: true, url: toUrl(out), cached: true };
  }
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const pct = (p) => onProgress && onProgress({ file: src, pct: p });
    pct(0);
    const duration = await probeDuration(ff, src);

    // 1) 只换容器
    let r = await run(ff, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src,
      "-c", "copy", "-movflags", "+faststart", out], duration, pct);
    let mode = "copy";
    if (!r.ok) {
      // 2) 完整转码（含音频）
      mode = "encode";
      r = await run(ff, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-progress", "pipe:1", out], duration, pct);
      if (!r.ok) {
        // 3) 没有音轨等情况：丢弃音频再试
        r = await run(ff, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-an", "-movflags", "+faststart", "-progress", "pipe:1", out], duration, pct);
        mode = "encode-silent";
      }
    }
    if (!r.ok) {
      try { fs.unlinkSync(out); } catch (e) {}
      return { ok: false, error: "ffmpeg 转换失败（退出码 " + r.code + "），可能文件已损坏" };
    }
    try { fs.writeFileSync(done, String(Date.now())); } catch (e) {}
    pct(100);
    return { ok: true, url: toUrl(out), mode: mode, cached: false };
  })();

  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

function toUrl(p) {
  let u = p.replace(/\\/g, "/");
  if (!u.startsWith("/")) u = "/" + u;
  return "file://" + u.split("/").map(encodeURIComponent).join("/").replace(/%3A/g, ":");
}

module.exports = { transcode, hasFfmpeg, findFfmpeg, TRANSCODE_RE };
