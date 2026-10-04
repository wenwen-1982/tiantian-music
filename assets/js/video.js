/* ============================================================
 * 天天音乐 · 视频播放引擎
 * 包装页面中的 <video id="videoEl">，对外提供与音频引擎一致的接口：
 *   load / play / pause / seek / 音量 / 倍速 / 事件订阅
 * 事件：loaded / play / pause / ended / error / timeupdate / rate
 * ============================================================ */
window.TTVideo = (function () {
  const events = {};
  function on(ev, cb) { (events[ev] = events[ev] || []).push(cb); }
  function emit(ev, payload) { (events[ev] || []).forEach((cb) => { try { cb(payload); } catch (e) { console.error(e); } }); }

  let el = null;
  let track = null;
  let volume = 0.7;
  let rate = 1;
  let rafId = null;

  function ensureEl() {
    if (!el) el = document.getElementById("videoEl");
    if (!el) return null;
    if (!el._ttBound) {
      el._ttBound = true;
      el.volume = volume;
      el.playbackRate = rate;
      el.addEventListener("play", () => { emit("play"); startLoop(); });
      el.addEventListener("playing", () => { emit("play"); startLoop(); });
      el.addEventListener("pause", () => { emit("pause"); stopLoop(); });
      el.addEventListener("ended", () => { emit("ended"); stopLoop(); });
      el.addEventListener("loadedmetadata", () => emit("loaded", { duration: duration() }));
      el.addEventListener("durationchange", () => emit("loaded", { duration: duration() }));
      el.addEventListener("ratechange", () => emit("rate", el.playbackRate));
      el.addEventListener("error", () => {
        if (el.getAttribute("src")) emit("error", new Error("视频加载失败：格式不支持或文件已被移动"));
      });
    }
    return el;
  }

  /* ---------------- 时间轴 ---------------- */
  function duration() {
    const v = ensureEl();
    return v && isFinite(v.duration) ? v.duration : 0;
  }
  function currentTime() {
    const v = ensureEl();
    return v ? (v.currentTime || 0) : 0;
  }
  function isPlaying() {
    const v = ensureEl();
    return !!v && !v.paused && !v.ended && v.readyState > 2;
  }

  function loop() {
    emit("timeupdate", { current: currentTime(), duration: duration() });
    rafId = requestAnimationFrame(loop);
  }
  function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  /* ---------------- 控制 ---------------- */
  function load(t, opts) {
    opts = opts || {};
    const v = ensureEl();
    if (!v) return;
    track = t;
    if (!t) { pause(); v.removeAttribute("src"); try { v.load(); } catch (e) {} v.dataset.url = ""; return; }
    if (v.dataset.url !== t.url) {
      v.src = t.url;
      v.dataset.url = t.url;
      try { v.currentTime = 0; } catch (e) {}
    }
    v.playbackRate = rate;
    v.volume = volume;
    emit("loaded", { duration: duration() });
    if (opts.autoplay) play();
  }

  function play() {
    const v = ensureEl();
    if (!v || !track) return;
    v.play().then(() => { emit("play"); startLoop(); }).catch((e) => emit("error", e));
  }
  function pause() {
    const v = ensureEl();
    if (v && !v.paused) v.pause();
    stopLoop();
  }
  function toggle() { isPlaying() ? pause() : play(); }

  function seek(sec) {
    const v = ensureEl();
    if (!v || !track) return;
    const d = duration();
    sec = Math.max(0, Math.min(sec, d > 0 ? d : sec));
    try { v.currentTime = sec; } catch (e) {}
    emit("timeupdate", { current: sec, duration: d });
  }

  function setVolume(x) {
    volume = Math.max(0, Math.min(1, x));
    const v = ensureEl();
    if (v) v.volume = volume;
  }
  function getVolume() { return volume; }

  function setRate(r) {
    rate = Math.max(0.25, Math.min(4, r || 1));
    const v = ensureEl();
    if (v) v.playbackRate = rate;
    emit("rate", rate);
  }
  function getRate() { return rate; }

  function stop() {
    const v = ensureEl();
    if (!v) return;
    try { v.pause(); } catch (e) {}
    stopLoop();
  }

  /* ---------------- 全屏 / 画中画 ---------------- */
  function toggleFullscreen(node) {
    const target = node || document.getElementById("videoStage") || ensureEl();
    if (!target) return;
    try {
      if (document.fullscreenElement) {
        const p0 = document.exitFullscreen();
        if (p0 && p0.catch) p0.catch(() => {});
        return;
      }
      const req = target.requestFullscreen || target.webkitRequestFullscreen;
      if (!req) { emit("fullscreenerror", "当前环境不支持全屏"); return; }
      const p = req.call(target);
      if (p && p.catch) p.catch(() => emit("fullscreenerror", "当前环境不允许全屏（可在系统设置中检查）"));
    } catch (e) {
      emit("fullscreenerror", "全屏失败：" + (e.message || e));
    }
  }
  function togglePip() {
    const v = ensureEl();
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        const p0 = document.exitPictureInPicture();
        if (p0 && p0.catch) p0.catch(() => {});
        return;
      }
      if (!v.requestPictureInPicture) { emit("piperror", "当前环境不支持画中画"); return; }
      const p = v.requestPictureInPicture();
      if (p && p.catch) p.catch(() => emit("piperror", "当前环境不允许画中画"));
    } catch (e) {
      emit("piperror", "画中画失败：" + (e.message || e));
    }
  }
  function isFullscreen() { return !!document.fullscreenElement; }

  return {
    on, load, play, pause, toggle, seek, stop,
    setVolume, getVolume, setRate, getRate,
    currentTime, duration, isPlaying, ensureEl,
    toggleFullscreen, togglePip, isFullscreen,
    getTrack: () => track,
  };
})();
