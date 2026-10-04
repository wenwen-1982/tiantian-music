/* 下载精简版 ffmpeg.exe（约 61 MB）到 build/ffmpeg.exe
 * 源：npm 包 @ffmpeg-installer/win32-x64（FFmpeg 4.1，GPL，含 libx264 / aac
 * 与 VC-1 / WMV / MPEG-4 Part2 / MJPEG / FLV-Sorenson / VP6 / WMA 等老解码器）
 * 想要更新的版本可自行替换同目录的 ffmpeg.exe。
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");

/* 最小 tar 提取器：只取 package/ffmpeg.exe，避免依赖外部 tar */
function extractExe(tgzPath, destFile) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (!name) break;
    const sizeStr = buf.toString("utf8", off + 124, off + 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const start = off + 512;
    if (/ffmpeg\.exe$/i.test(name)) {
      fs.writeFileSync(destFile, buf.slice(start, start + size));
      return true;
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return false;
}

const URL = "https://registry.npmmirror.com/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz";
const DEST = path.join(__dirname, "ffmpeg.exe");
const TMP = path.join(__dirname, "ffmpeg.tgz");

function get(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) > 5) return reject(new Error("重定向过多"));
        return resolve(get(res.headers.location, dest, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("下载超时")); });
  });
}

(async () => {
  if (fs.existsSync(DEST)) {
    console.log("已存在 build/ffmpeg.exe，" + (fs.statSync(DEST).size / 1048576).toFixed(1) + " MB，跳过下载");
    return;
  }
  console.log("下载 ffmpeg（npmmirror）…");
  await get(URL, TMP);
  console.log("解压…");
  if (!extractExe(TMP, DEST)) throw new Error("压缩包里没有找到 ffmpeg.exe");
  fs.unlinkSync(TMP);
  console.log("完成: " + DEST + "  " + (fs.statSync(DEST).size / 1048576).toFixed(1) + " MB");
})().catch((e) => { console.error("失败: " + (e && e.message || e)); process.exit(1); });
