const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ttDesktop", {
  isDesktop: true,
  win: (action) => ipcRenderer.send("tt-win", action),
  download: (job) => ipcRenderer.invoke("tt-download", job),
  onProgress: (cb) => ipcRenderer.on("tt-progress", (e, p) => cb(p)),
  chooseDir: () => ipcRenderer.invoke("tt-choose-dir"),
  defaultDir: () => ipcRenderer.invoke("tt-default-dir"),
  pickFiles: () => ipcRenderer.invoke("tt-pick-files"),
  scanDir: () => ipcRenderer.invoke("tt-scan-dir"),
  openPath: (p) => ipcRenderer.send("tt-open-path", p),
});
