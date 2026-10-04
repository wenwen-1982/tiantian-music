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
});
