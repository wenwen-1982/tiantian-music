/* 打包天天音乐 app.asar（只含运行所需文件）
 * 关键防护：所有文本文件先去除 UTF-8 BOM 再打包。
 * Electron 主进程用 JSON.parse 读 package.json，BOM 会导致
 * "Unexpected token '﻿'" 启动崩溃（A JavaScript error occurred in the main process）。
 */
const asar = require("@electron/asar");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..");
const STAGE = path.join(process.env.TEMP || "/tmp", "tt_stage_asar");
const OUT = path.join(process.env.TEMP || "/tmp", "tt_app.asar");

// 需要进包的内容（目录会递归展开，避免新增文件忘记登记）
const ROOTS = ["index.html", "installer.html", "package.json", "assets", "electron"];
// 不进包的东西
const EXCLUDE = /(?:^|[\\/])(?:node_modules|\.git|release|preview|build)(?:[\\/]|$)|\.map$|\.md$/i;

function collectFiles() {
  const out = [];
  for (const r of ROOTS) {
    const full = path.join(SRC, r);
    let st = null;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isFile()) { out.push(r); continue; }
    (function walk(dir, rel) {
      let items = [];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const it of items) {
        const child = path.join(rel, it.name);
        if (EXCLUDE.test(child)) continue;
        if (it.isDirectory()) walk(path.join(dir, it.name), child);
        else out.push(child);
      }
    })(full, r);
  }
  return out;
}

const TEXT_FILES = collectFiles();

function stripBom(buf, name) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    if (name === "package.json") {
      // package.json 必须无 BOM，否则 Electron 启动即崩
      JSON.parse(buf.slice(3).toString("utf8"));
    }
    console.log("BOM removed:", name);
    return buf.slice(3);
  }
  return buf;
}

fs.rmSync(STAGE, { recursive: true, force: true });
for (const rel of TEXT_FILES) {
  const dir = path.dirname(path.join(STAGE, rel));
  fs.mkdirSync(dir, { recursive: true });
  const raw = fs.readFileSync(path.join(SRC, rel));
  fs.writeFileSync(path.join(STAGE, rel), stripBom(raw, rel));
}

// 允许用 TT_PACK_VERSION 覆盖版本号：用于自测「旧版 → 新版」升级链路，
// 不改动仓库里的 package.json。
if (process.env.TT_PACK_VERSION) {
  const pkgPath = path.join(STAGE, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  console.log("版本覆盖:", pkg.version, "->", process.env.TT_PACK_VERSION);
  pkg.version = String(process.env.TT_PACK_VERSION);
  fs.writeFileSync(pkgPath, Buffer.from(JSON.stringify(pkg, null, 2), "utf8"));
}

asar.createPackage(STAGE, OUT).then(() => {
  console.log("packed:", OUT, fs.statSync(OUT).size, "bytes");
  console.log("下一步: 复制到 <安装目录>/resources/app.asar 覆盖即可");
}).catch((e) => { console.error("PACK FAILED:", e.stack); process.exit(1); });
