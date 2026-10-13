/* ============================================================
 * 纯 Node 的 zip 解压器（零依赖，支持 store + deflate）
 * ------------------------------------------------------------
 * 为什么不用现成的：
 *   - Windows 自带的 Expand-Archive 依赖 PowerShell（受限环境常被安全策略拦）；
 *   - tar.exe 在部分裁剪系统上不存在；
 *   - 早点名的手写解析在离线环境最稳，也能在测试里直接跑。
 * 支持：普通 zip / 中文文件名（UTF-8 标志位或 fallback）/ 目录项。
 * 不支持（用不到）：zip64、加密、分卷。
 * ============================================================ */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIG_EOCD = 0x06054b50;   // End of central directory
const SIG_CEN = 0x02014b50;    // Central directory entry
const SIG_LOC = 0x04034b50;    // Local file header

function findEocd(buf) {
  // EOCD 在文件末尾，注释最长 65535，往前扫最多 64KB + 22
  const min = Math.max(0, buf.length - (65535 + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/* 解析中央目录，拿到每个条目的元信息 */
function readEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是有效的 zip 文件（找不到中央目录）");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) throw new Error("暂不支持 zip64 格式的压缩包");

  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== SIG_CEN) throw new Error("中央目录损坏（偏移 " + offset + "）");
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const rawSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const cmtLen = buf.readUInt16LE(offset + 32);
    if (compSize === 0xffffffff || rawSize === 0xffffffff) throw new Error("暂不支持 zip64 格式的压缩包");
    const localOffset = buf.readUInt32LE(offset + 42);
    const rawName = buf.subarray(offset + 46, offset + 46 + nameLen);

    // bit 11 置位说明文件名是 UTF-8；否则按 UTF-8 解（本项目的包都是 UTF-8），
    // 解出替换字符时再退回 latin1 保底，避免直接崩。
    let name = rawName.toString("utf8");
    if (!(flags & 0x800) && name.indexOf("\uFFFD") >= 0) name = rawName.toString("latin1");

    out.push({ name: name.replace(/\\/g, "/"), method, compSize, size: rawSize, localOffset, isDir: /\/$/.test(name) });
    offset += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/* 读出单个条目解压后的内容 */
function readEntry(buf, e) {
  if (e.isDir) return Buffer.alloc(0);
  const lo = e.localOffset;
  if (buf.readUInt32LE(lo) !== SIG_LOC) throw new Error("本地文件头损坏：" + e.name);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error("不支持的压缩方式 " + e.method + "（" + e.name + "）");
}

/* 防目录穿越：条目名必须落在目标目录内 */
function safeJoin(destDir, name) {
  const full = path.resolve(destDir, name);
  const root = path.resolve(destDir);
  if (full !== root && full.indexOf(root + path.sep) !== 0) {
    throw new Error("压缩包内存在非法路径：" + name);
  }
  return full;
}

/**
 * 解压 zip 到目录
 * @param {string} zipPath zip 文件路径
 * @param {string} destDir 目标目录（自动创建）
 * @param {(p:{current:number,total:number,file:string})=>void} [onProgress]
 * @returns {{files:number, names:string[]}}
 */
function extract(zipPath, destDir, onProgress) {
  const buf = fs.readFileSync(zipPath);
  const entries = readEntries(buf);
  fs.mkdirSync(destDir, { recursive: true });
  const names = [];
  let done = 0;
  // 关键：Electron 给 fs 打了 asar 补丁，凡是路径里出现 ".asar" 的读写都会被当成
  // 「打开某个 asar 压缩包」，解压到 resources/app.asar 时必然报
  // "Invalid package ..."。用 process.noAsar 临时关掉该补丁。
  const prevNoAsar = process.noAsar;
  try {
    process.noAsar = true;
    for (const e of entries) {
      const target = safeJoin(destDir, e.name);
      if (e.isDir) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, readEntry(buf, e));
      names.push(e.name);
      done += 1;
      if (onProgress) onProgress({ current: done, total: entries.length, file: e.name });
    }
  } finally {
    process.noAsar = prevNoAsar;
  }
  return { files: names.length, names };
}

module.exports = { extract, readEntries };
