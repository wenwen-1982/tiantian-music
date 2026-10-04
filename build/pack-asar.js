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

const TEXT_FILES = [
  "index.html",
  "package.json",
  "assets/css/style.css",
  "assets/js/app.js",
  "assets/js/api.js",
  "assets/js/engine.js",
  "assets/js/library.js",
  "assets/js/video.js",
  "assets/icon.png",
  "electron/main.js",
  "electron/preload.js",
];

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

asar.createPackage(STAGE, OUT).then(() => {
  console.log("packed:", OUT, fs.statSync(OUT).size, "bytes");
  console.log("下一步: 复制到 <安装目录>/resources/app.asar 覆盖即可");
}).catch((e) => { console.error("PACK FAILED:", e.stack); process.exit(1); });
