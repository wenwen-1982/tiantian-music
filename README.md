# 天天音乐 (TianTian Music)

本地 + 开放版权曲库音乐播放器。界面风格致敬「方格音乐」：深色无边框窗口、左侧导航、底部播放条、紫蓝强调色。

![播放界面](preview/02-playing.png)

## 下载（Windows 免安装版）

| 版本 | 文件 | 说明 |
|---|---|---|
| v1.0.0 | [TianTianMusic-v1.0.0-win64.zip](https://github.com/wenwen-1982/tiantian-music/releases/download/v1.0.0/TianTianMusic-v1.0.0-win64.zip) | Windows 10/11 64 位绿色版，105.6 MB，解压后双击 `天天音乐.exe` 即可运行，无需安装 |

全部版本见 [Releases](https://github.com/wenwen-1982/tiantian-music/releases)。

## 功能

| 模块 | 说明 |
|---|---|
| 内置示例曲库 | 8 首合成器曲目由 WebAudio 实时生成（无需任何音频文件即可试听），含推荐歌单、排行榜 |
| 本地音乐 | 导入文件 / 文件夹 / 拖拽入窗口；自动解析 MP3 ID3v2 标签与内嵌封面 |
| 歌词 | LRC 解析 + 逐行高亮卡拉OK式滚动；LRCLIB 联网匹配；支持手动导入 .lrc |
| 在线曲库 | ccMixter（CC 授权）搜索、在线播放、下载到本地；桌面版带进度显示 |
| 播放控制 | 顺序 / 单曲循环 / 随机、播放队列、收藏、最近播放、频谱可视化 |
| 主题 | 6 种主题色、深色 / 浅色模式，全部设置本地持久化 |
| 快捷键 | 空格播放暂停 · ←/→ 快退快进 5s · Ctrl+←/→ 切歌 · ↑/↓ 音量 · Esc 关闭歌词页 |

| 发现页 | 歌词页 |
|---|---|
| ![发现](preview/01-discover.png) | ![歌词](preview/03-nowpanel.png) |

## 运行

### 浏览器预览（零依赖）

直接双击打开 `index.html`，或在项目目录执行：

```bash
npx serve .
```

> 浏览器模式下「在线曲库」可能受跨域策略限制，本地播放 / 歌词 / 合成器曲目均正常。

### 桌面版（推荐，功能完整）

```bash
npm install        # 安装 electron
npm start          # 启动桌面版
```

桌面版特性：无边框自绘标题栏、本地文件/文件夹选择对话框、递归扫描目录、下载到指定目录（默认 `音乐\天天音乐下载`）。

## 打包 Windows 免安装版

```bash
npm run dist       # electron-builder → 便携版 exe
```

产物为绿色免安装目录 / 单文件 exe，双击 `天天音乐.exe` 即可运行。已发布的成品见上方 [下载](#下载windows-免安装版)。

> 若网络无法直连 npm 的 Electron 二进制源，可先手动下载 `electron-v31.7.7-win32-x64.zip`（如 npmmirror 镜像），解压后将本项目代码打成 `resources/app.asar`（推荐用 `@electron/asar` 的 `createPackage` API），并把 `electron.exe` 重命名为 `天天音乐.exe` 即可得到便携版。

## 目录结构

```
tiantian-music/
├── index.html            # 应用外壳
├── assets/
│   ├── css/style.css     # 主题样式
│   ├── icon.png          # 应用图标（512×512）
│   └── js/
│       ├── engine.js     # 音频引擎（文件播放 + WebAudio 合成器 + 频谱）
│       ├── library.js    # 曲库数据 / ID3 解析 / LRC 解析 / 存储
│       ├── api.js        # ccMixter / LRCLIB / 下载接口
│       └── app.js        # 界面状态与交互
├── electron/
│   ├── main.js           # 主进程（窗口 / 下载 / 文件扫描）
│   └── preload.js        # contextBridge 桥接
├── build/icon.ico        # Windows 打包图标（多尺寸）
└── preview/              # 运行截图
```

## 技术要点

- **零音频素材**：内置曲目由 `OscillatorNode` / `BiquadFilter` / 噪声鼓组合成，纯代码生成。
- **ID3v2 解析**：手写 MP3 标签解析器，读取标题/歌手/专辑/APIC 内嵌封面，不依赖三方库。
- **LRC 解析**：支持多时间戳行、逐行二分查找定位当前句。
- **可视化**：`AnalyserNode` 实时频谱绘制到 Canvas。
- **持久化**：收藏、历史、主题、音量等状态存于 `localStorage`。

## 版权说明

在线曲库仅接入 **ccMixter（CC 授权）** 与歌词库 **LRCLIB** 等开放版权内容源；本地文件播放不涉及任何在线音源。请遵守各曲目标注的授权条款。本项目仅用于学习与技术交流。

## License

[MIT](LICENSE)
