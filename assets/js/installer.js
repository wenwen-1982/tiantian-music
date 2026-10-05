/* 安装 / 卸载界面逻辑 */
(function () {
  const D = window.ttDesktop;
  const $ = (s) => document.querySelector(s);
  const show = (id) => ["stepSetup", "stepProgress", "stepDone", "stepUninstall"]
    .forEach((k) => { $("#" + k).style.display = k === id ? "block" : "none"; });

  let info = null;
  let mode = "install";
  let installedExe = "";

  /* 标题栏 */
  if (D) {
    $("#winMin").onclick = () => D.win("min");
    $("#winClose").onclick = () => D.win("close");
  } else {
    $("#winControls").style.display = "none";
  }

  function log(el, text) {
    const line = document.createElement("div");
    line.className = "ins-log-line";
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function renderExts() {
    const audio = $("#chkAudio").checked;
    const video = $("#chkVideo").checked;
    const list = (audio ? info.audioExts : []).concat(video ? info.videoExts : []);
    $("#extPreview").textContent = list.length
      ? list.map((e) => "." + e).join("  ")
      : "（未选择，安装后不会关联任何格式）";
    return list;
  }

  function init(data) {
    mode = data.mode || "install";
    if (mode === "uninstall") {
      document.title = "卸载 天天音乐";
      $("#insTitle").textContent = "卸载 天天音乐";
      show("stepUninstall");
    }
    if (!D) return;
    D.installerDefaults().then((r) => {
      if (!r || !r.ok) { $("#heroSub").textContent = "初始化失败：" + ((r && r.error) || "未知错误"); return; }
      info = r.info;
      if (mode === "uninstall") {
        $("#uniPath").textContent = "安装位置：" + (info.installedDir || info.suggestedDir);
        $("#uniSub").textContent = "将删除 " + (info.installedDir || info.suggestedDir) + " 下的程序文件、开始菜单快捷方式与文件关联";
        return;
      }
      $("#insDir").value = info.suggestedDir;
      if (info.isInstalled) {
        $("#heroTitle").textContent = "修复 / 重装 天天音乐";
        $("#heroSub").textContent = "检测到已安装到 " + info.installedDir + "，重新安装会覆盖该目录";
        $("#btnInstall").textContent = "重新安装";
      }
      $("#dirHint").textContent = "源：" + info.sourceDir + "（约 " + Math.max(1, Math.round(estimateSize() / 1048576)) + " MB）";
      renderExts();
    });
  }

  function estimateSize() {
    // ffmpeg 61MB + Electron 运行时约 180MB，仅作提示
    return 250 * 1024 * 1024;
  }

  /* 事件 */
  $("#chkAudio").onchange = renderExts;
  $("#chkVideo").onchange = renderExts;
  $("#btnCancel").onclick = () => { if (D) D.quitApp(); };
  $("#btnUniCancel").onclick = () => { if (D) D.quitApp(); };

  $("#btnBrowse").onclick = () => {
    if (!D) return;
    D.chooseDir().then((p) => { if (p) $("#insDir").value = p; });
  };

  $("#btnInstall").onclick = () => {
    const dir = ($("#insDir").value || "").trim();
    if (!dir) return;
    const exts = renderExts();
    show("stepProgress");
    $("#progFill").style.width = "0%";
    const logEl = $("#progLog");
    logEl.innerHTML = "";
    const phases = { copy: "正在复制文件…", assoc: "正在写入文件关联…", shortcut: "正在创建快捷方式…", done: "完成" };
    D.onInstallProgress((p) => {
      if (!p) return;
      $("#progSub").textContent = phases[p.phase] || p.phase;
      if (p.phase === "copy" && p.total) {
        const pct = Math.round((p.current / p.total) * 100);
        $("#progFill").style.width = pct + "%";
        if (p.file && p.current % 12 === 0) log(logEl, p.file);
      } else if (p.phase === "assoc") {
        $("#progFill").style.width = "92%";
        log(logEl, "写入文件关联与卸载信息");
      } else if (p.phase === "shortcut") {
        $("#progFill").style.width = "97%";
        log(logEl, "创建开始菜单快捷方式");
      } else if (p.phase === "done") {
        $("#progFill").style.width = "100%";
      }
    });
    D.installerRun({ dir, exts, desktopShortcut: $("#chkDesktop").checked }).then((res) => {
      window.setTimeout(() => {
        show("stepDone");
        installedExe = (res && res.exePath) || "";
        if (!res || !res.ok) {
          $("#doneTitle").textContent = "安装未完成";
          $("#doneSub").textContent = (res && res.error) || "请检查目标目录权限后重试";
          return;
        }
        $("#doneSub").textContent = "已安装到 " + res.dir
          + (res.assocOk ? "" : "（文件关联写入失败：" + res.assocError + "）")
          + (res.copyFailures && res.copyFailures.length ? "｜未复制：" + res.copyFailures.join(", ") : "");
        const ol = $("#doneSteps");
        ol.innerHTML = "";
        [
          "双击音乐 / 视频文件即可用天天音乐打开",
          "若某类文件仍被其它程序占用，点「在系统设置中设为默认」切换",
          "老格式（avi / wmv / flv）首次播放会自动转换，之后走缓存",
        ].forEach((t) => { const li = document.createElement("li"); li.textContent = t; ol.appendChild(li); });
      }, 350);
    });
  };

  $("#btnSetDefault").onclick = () => { if (D) D.openDefaultApps(); };
  $("#btnOpenFolder").onclick = () => {
    if (D && info) D.openPath((info.installedDir || info.suggestedDir));
  };
  $("#btnLaunch").onclick = () => {
    if (!D) return;
    const exe = installedExe || (info ? info.exePath : "");
    if (exe) D.openPath(exe);
    window.setTimeout(() => D.quitApp(), 400);
  };

  $("#btnUninstall").onclick = () => {
    const logEl = $("#uniLog");
    logEl.style.display = "block";
    logEl.innerHTML = "";
    $("#btnUninstall").disabled = true;
    log(logEl, "正在清理…");
    D.installerUninstall().then((res) => {
      (res && res.steps ? res.steps : ["已完成"]).forEach((s) => log(logEl, s));
      log(logEl, "卸载完成，即将退出。");
      window.setTimeout(() => { if (D) D.quitApp(); }, 1200);
    });
  };

  if (D) {
    D.installerInit(init);
  } else {
    init({ mode: "install" });
  }
})();
