/* 把最新代码同步到已安装的便携版目录
 *   node build/deploy.js "D:\天天音乐"
 * 会覆盖 resources\app.asar，并确保 resources\ffmpeg.exe 存在
 * （ffmpeg.exe 不能放进 asar，必须与应用资源同级）
 */
const fs = require("fs");
const path = require("path");

const TARGET = process.argv[2] || "D:\\天天音乐";
const ASAR = path.join(process.env.TEMP || "/tmp", "tt_app.asar");
const FF = path.join(__dirname, "ffmpeg.exe");

if (!fs.existsSync(TARGET)) { console.error("目标目录不存在: " + TARGET); process.exit(1); }
if (!fs.existsSync(ASAR)) { console.error("没有找到打包产物 " + ASAR + "，先运行 npm run pack"); process.exit(1); }

const res = path.join(TARGET, "resources");
fs.mkdirSync(res, { recursive: true });

const destAsar = path.join(res, "app.asar");
if (fs.existsSync(destAsar)) {
  const bak = path.join(res, "app.asar.prev");
  fs.copyFileSync(destAsar, bak);
  console.log("已备份旧包 -> " + bak);
}
fs.copyFileSync(ASAR, destAsar);
console.log("已更新 " + destAsar + "  " + fs.statSync(destAsar).size + " bytes");

const destFf = path.join(res, "ffmpeg.exe");
if (fs.existsSync(FF)) {
  fs.copyFileSync(FF, destFf);
  console.log("已更新 " + destFf + "  " + (fs.statSync(destFf).size / 1048576).toFixed(1) + " MB");
} else if (!fs.existsSync(destFf)) {
  console.log("提示: 未找到 build/ffmpeg.exe，老格式转码将不可用；运行 npm run fetch-ffmpeg 下载");
}
console.log("完成");
