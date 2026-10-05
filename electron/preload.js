const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ttDesktop", {
  isDesktop: true,
  win: (action) => ipcRenderer.send("tt-win", action),
  download: (job) => ipcRenderer.invoke("tt-download", job),
  onProgress: (cb) => ipcRenderer.on("tt-progress", (e, p) => cb(p)),
  chooseDir: () => ipcRenderer.invoke("tt-choose-dir"),
  defaultDir: () => ipcRenderer.invoke("tt-default-dir"),
  pickFiles: () => ipcRenderer.invoke("tt-pick-files"),
  pickVideos: () => ipcRenderer.invoke("tt-pick-videos"),
  scanDir: () => ipcRenderer.invoke("tt-scan-dir"),
  scanVideoDir: () => ipcRenderer.invoke("tt-scan-video-dir"),
  openPath: (p) => ipcRenderer.send("tt-open-path", p),
  hasFfmpeg: () => ipcRenderer.invoke("tt-has-ffmpeg"),
  transcode: (file) => ipcRenderer.invoke("tt-transcode", file),
  onTranscode: (cb) => ipcRenderer.on("tt-transcode-progress", (e, p) => cb(p)),

  // 双击关联文件 / 从资源管理器打开
  onOpenFiles: (cb) => ipcRenderer.on("tt-open-files", (e, files) => cb(files)),
  takePendingFiles: () => ipcRenderer.invoke("tt-take-pending"),

  // 安装 / 卸载 / 默认播放器
  installerInit: (cb) => ipcRenderer.on("tt-installer-init", (e, d) => cb(d)),
  installerDefaults: () => ipcRenderer.invoke("tt-installer-defaults"),
  installerRun: (opts) => ipcRenderer.invoke("tt-installer-run", opts),
  installerUninstall: () => ipcRenderer.invoke("tt-installer-uninstall"),
  onInstallProgress: (cb) => ipcRenderer.on("tt-install-progress", (e, p) => cb(p)),
  openDefaultApps: () => ipcRenderer.send("tt-open-default-apps"),
  openInstaller: () => ipcRenderer.send("tt-open-installer"),
  quitApp: () => ipcRenderer.send("tt-quit"),
});
