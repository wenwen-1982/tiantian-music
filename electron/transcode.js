/* ============================================================
 * 视频转码：让浏览器内核播不了的视频能播
 *
 * 要处理两类问题：
 *   1) 容器不认（avi / wmv / flv / rmvb / mpg …）
 *   2) 容器认识、但编码不支持 —— 例如 mp4 里装 HEVC / H.265，
 *      表现为「有声音、没画面、也不报错」（Chromium 直接忽略视频轨）
 *
 * Chromium 内置解码器白名单：
 *   视频 H.264 / VP8 / VP9 / AV1 / Theora
 *   音频 AAC / MP3 / Opus / Vorbis / FLAC
 *
 * 策略：
 *   先用 ffmpeg -i 分析源流编码；
 *   编码本来就支持 → 先试 -c copy（秒级、无损），并对产物做二次校验；
 *   编码不支持或 copy 失败 → libx264 + aac 转码；再失败则丢音频兜底。
 * 结果按「路径 + 大小 + 修改时间」缓存到系统临时目录。
 * ============================================================ */
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

const TRANSCODE_RE = /\.(avi|wmv|flv|f4v|swf|rm|rmvb|mpg|mpeg|mpe|m1v|m2v|vob|asf|3gp|3g2|mts|m2ts|ts|dat|ogv)$/i;
const MAX_MS = 20 * 60 * 1000;

/* Chromium 能解的编码白名单 */
const V_OK_RE = /^(h264|avc1|vp8|vp9|av1|theora)$/i;
const A_OK_RE = /^(aac|mp3|opus|vorbis|flac)$/i;

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

/* file:// URL → 本地路径；顺带归一化 Windows 双斜杠 */
function normalizePath(p) {
  let src = String(p || "");
  if (/^file:\/\//i.test(src)) {
    src = decodeURIComponent(src.replace(/^file:\/\//i, ""));
    src = src.replace(/^\/([a-zA-Z]:)/, "$1");
  }
  return src.replace(/\\/g, "/");
}

/* ---------------- ffmpeg -i 输出解析 ---------------- */
function parseProbe(text) {
  const out = { duration: 0, video: "", audio: "", videoOk: true, audioOk: true };
  const dm = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(text);
  if (dm) out.duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
  for (const line of String(text).split(/\r?\n/)) {
    if (!/^\s*Stream #/.test(line)) continue;
    // 封面图会被 ffmpeg 当成视频流，标记为 attached pic，不能算播放用视频轨
    if (/\(attached[ _]?pic\)/i.test(line)) continue;
    if (!out.video) {
      const v = /Video:\s*([A-Za-z0-9_]+)/.exec(line);
      if (v) out.video = v[1].toLowerCase();
    }
    if (!out.audio) {
      const a = /Audio:\s*([A-Za-z0-9_]+)/.exec(line);
      if (a) out.audio = a[1].toLowerCase();
    }
  }
  // 解析不到流信息时按「支持」处理，否则会误判成需要转码
  out.videoOk = !out.video || V_OK_RE.test(out.video);
  out.audioOk = !out.audio || A_OK_RE.test(out.audio);
  out.needsTranscode = !out.videoOk || !out.audioOk;
  return out;
}

function probeStreams(ff, file) {
  return new Promise((resolve) => {
    let err = "";
    let p;
    try { p = spawn(ff, ["-hide_banner", "-i", file], { windowsHide: true }); }
    catch (e) { return resolve(parseProbe("")); }
    p.stderr.on("data", (d) => { if (err.length < 400000) err += d.toString(); });
    p.on("error", () => resolve(parseProbe("")));
    p.on("close", () => resolve(parseProbe(err)));
  });
}

/* 按「路径 + 大小 + mtime」缓存探测结果 */
const probeCache = new Map();
function fileKey(src, st) {
  return crypto.createHash("md5")
    .update(src + "|" + st.size + "|" + Math.floor(st.mtimeMs || 0)).digest("hex");
}
async function probeFile(ff, src, st) {
  const key = fileKey(src, st);
  if (probeCache.has(key)) return probeCache.get(key);
  const info = await probeStreams(ff, src);
  if (probeCache.size > 300) probeCache.clear();
  probeCache.set(key, info);
  return info;
}

/* 对外：探测一个文件的流编码（前端决定是否需要转码） */
async function probe(file) {
  const ff = findFfmpeg();
  if (!ff) return { ok: false, error: "未找到 ffmpeg.exe（发布包内应位于安装目录 resources 下）" };
  const src = normalizePath(file);
  if (!src) return { ok: false, error: "文件路径为空" };
  let st;
  try { st = fs.statSync(src); } catch (e) { return { ok: false, error: "文件不存在或无法读取" }; }
  const info = await probeFile(ff, src, st);
  return Object.assign({ ok: true, file: src }, info);
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

/**
 * @param file       文件路径或 file:// URL
 * @param onProgress 进度回调 ({ file, pct })
 * @param opts       { info?: 已探测的流信息, forceEncode?: 强制转码（不做 -c copy） }
 */
async function transcode(file, onProgress, opts) {
  opts = opts || {};
  const ff = findFfmpeg();
  if (!ff) return { ok: false, error: "未找到 ffmpeg.exe（发布包内应位于安装目录 resources 下）" };
  const src = normalizePath(file);
  if (!src) return { ok: false, error: "文件路径为空" };
  let st;
  try { st = fs.statSync(src); } catch (e) { return { ok: false, error: "文件不存在或无法读取" }; }

  const key = fileKey(src, st);
  const dir = path.join(app.getPath("temp"), "tiantian-music-transcode");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const out = path.join(dir, key + ".mp4");
  const done = path.join(dir, key + ".done");

  if (fs.existsSync(done) && fs.existsSync(out)) {
    return { ok: true, url: toUrl(out), mode: "cache", cached: true };
  }
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const pct = (p) => onProgress && onProgress({ file: src, pct: p });
    pct(0);

    const info = (opts.info && opts.info.video !== undefined)
      ? opts.info
      : await probeFile(ff, src, st);
    const duration = info.duration || 0;
    const srcUnsupported = !info.videoOk || !info.audioOk;
    // 编码本身浏览器就不认时，换容器毫无意义（例如 HEVC 装进 mp4 是合法的，
    // -c copy 会「成功」但产物依旧没画面），必须直接转码
    const forceEncode = !!opts.forceEncode || srcUnsupported;

    const COPY = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src,
      "-c", "copy", "-movflags", "+faststart", out];
    const ENCODE = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-progress", "pipe:1", out];
    const ENCODE_SILENT = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-an", "-movflags", "+faststart", "-progress", "pipe:1", out];

    let mode = "copy";
    let r = { ok: false };

    // 1) 编码本来就支持 → 只换容器
    if (!forceEncode) {
      r = await run(ff, COPY, duration, pct);
      // 二次校验：万一容器/编码判定有误，产物仍是浏览器不认的编码就作废重转
      if (r.ok) {
        const after = await probeStreams(ff, out);
        if (!after.videoOk || !after.audioOk) {
          try { fs.unlinkSync(out); } catch (e) {}
          r = { ok: false };
        }
      }
    }

    // 2) 完整转码（含音频）
    if (!r.ok) {
      mode = "encode";
      r = await run(ff, ENCODE, duration, pct);
      // 3) 没有音轨等情况：丢弃音频再试
      if (!r.ok) {
        mode = "encode-silent";
        r = await run(ff, ENCODE_SILENT, duration, pct);
      }
    }

    if (!r.ok) {
      try { fs.unlinkSync(out); } catch (e) {}
      return { ok: false, error: "ffmpeg 转换失败（退出码 " + r.code + "），可能文件已损坏" };
    }
    try { fs.writeFileSync(done, String(Date.now())); } catch (e) {}
    pct(100);
    return {
      ok: true, url: toUrl(out), mode: mode, cached: false,
      srcVideo: info.video, srcAudio: info.audio,
    };
  })();

  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

function toUrl(p) {
  let u = p.replace(/\\/g, "/");
  if (!u.startsWith("/")) u = "/" + u;
  return "file://" + u.split("/").map(encodeURIComponent).join("/").replace(/%3A/g, ":");
}

module.exports = {
  transcode, probe, hasFfmpeg, findFfmpeg, parseProbe,
  TRANSCODE_RE, V_OK_RE, A_OK_RE,
};
