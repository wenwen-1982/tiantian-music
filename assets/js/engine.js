/* ============================================================
 * 天天音乐 · 音频引擎
 * 支持两类音源：
 *   1) kind = "file"  —— 本地音频文件（HTMLAudioElement）
 *   2) kind = "synth" —— 内置合成器曲目（WebAudio 实时生成，无需下载音频）
 * 对外提供：load / play / pause / seek / 音量 / 频谱数据 / 事件订阅
 * ============================================================ */
window.TTEngine = (function () {
  const events = {};
  function on(ev, cb) { (events[ev] = events[ev] || []).push(cb); }
  function emit(ev, payload) { (events[ev] || []).forEach((cb) => { try { cb(payload); } catch (e) { console.error(e); } }); }

  const audio = new Audio();
  audio.preload = "metadata";

  let ctx = null, master = null, analyser = null, mediaSrc = null, noiseBuf = null;
  let track = null;                 // 当前曲目对象
  let playing = false;
  let synth = null;                 // 合成器实例
  let synthStartedAt = 0, synthOffset = 0;
  let volume = 0.7;
  let rafId = null;

  /* ---------------- 音频上下文 ---------------- */
  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.75;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    // 合成器/音源统一走 master
    return ctx;
  }

  function attachMedia() {
    ensureCtx();
    if (!mediaSrc) {
      try {
        mediaSrc = ctx.createMediaElementSource(audio);
        mediaSrc.connect(master);
      } catch (e) { /* 已连接过则忽略 */ }
    }
  }

  /* ---------------- 合成器 ---------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function createSynth(preset, offsetSec) {
    ensureCtx();
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(master);
    const stepDur = 60 / preset.bpm / 4;          // 十六分音符
    const rand = mulberry32(preset.seed);
    let step = Math.round(offsetSec / stepDur);
    let nextTime = ctx.currentTime + 0.06;
    let stopped = false;

    out.gain.setValueAtTime(0, ctx.currentTime);
    out.gain.linearRampToValueAtTime(preset.gain || 0.3, ctx.currentTime + 1.2);

    function note(freq, time, dur, type, vol, attack, release) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type || "triangle";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(vol, time + (attack || 0.02));
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur + (release || 0.3));
      o.connect(g); g.connect(out);
      o.start(time);
      o.stop(time + dur + (release || 0.3) + 0.05);
    }
    function chordNotes(deg, size) {
      const arr = [];
      for (let i = 0; i < size; i++) {
        const idx = deg + i * 2;
        const oct = Math.floor(idx / preset.scale.length);
        arr.push(preset.root + preset.scale[((idx % preset.scale.length) + preset.scale.length) % preset.scale.length] + oct * 12);
      }
      return arr;
    }
    function kick(time) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(130, time);
      o.frequency.exponentialRampToValueAtTime(45, time + 0.16);
      g.gain.setValueAtTime(0.5, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
      o.connect(g); g.connect(out);
      o.start(time); o.stop(time + 0.28);
    }
    function hat(time, vol) {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass"; hp.frequency.value = 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol || 0.08, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
      s.connect(hp); hp.connect(g); g.connect(out);
      s.start(time); s.stop(time + 0.08);
    }

    function scheduleStep(s, time) {
      const bar = Math.floor(s / 16) % preset.progress.length;
      const deg = preset.progress[bar];
      const inBar = s % 16;
      if (inBar === 0) {                            // 和弦垫
        chordNotes(deg, 3).forEach((m, i) => {
          note(mtof(m - 12), time + i * 0.02, stepDur * 30, "triangle", 0.075, 0.9, 1.4);
        });
      }
      if (inBar % 8 === 0) note(mtof(preset.root - 24 + preset.scale[deg % preset.scale.length]), time, 0.55, "sine", 0.2, 0.02, 0.5);
      if (preset.arp && inBar % 2 === 0) {          // 琶音
        const pool = chordNotes(deg, 3).concat([chordNotes(deg, 3)[0] + 12]);
        const m = pool[Math.floor(rand() * pool.length)];
        note(mtof(m), time + rand() * 0.01, 0.22 + rand() * 0.2, "triangle", 0.085, 0.01, 0.5);
      }
      if (preset.drums) {
        if (inBar === 0 || inBar === 8) kick(time);
        if (inBar % 4 === 2) hat(time, 0.06);
        if (inBar % 2 === 0) hat(time, 0.03);
      }
    }

    const timer = setInterval(() => {
      if (stopped) return;
      while (nextTime < ctx.currentTime + 0.3) {
        if (step * stepDur >= preset.duration) { emit("ended"); stopSynth(); return; }
        scheduleStep(step, nextTime);
        step++;
        nextTime += stepDur;
      }
    }, 80);

    function stopSynth() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        out.gain.cancelScheduledValues(ctx.currentTime);
        out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
        out.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
      } catch (e) {}
      setTimeout(() => { try { out.disconnect(); } catch (e) {} }, 400);
      synth = null;
    }
    return { stop: stopSynth, preset: preset };
  }

  /* ---------------- 时间轴 ---------------- */
  function duration() {
    if (!track) return 0;
    if (track.kind === "synth") return track.preset.duration;
    return isFinite(audio.duration) ? audio.duration : 0;
  }
  function currentTime() {
    if (!track) return 0;
    if (track.kind === "synth") {
      if (!synth) return Math.min(synthOffset, duration());
      return Math.min(synthOffset + (ctx.currentTime - synthStartedAt), duration());
    }
    return audio.currentTime || 0;
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
    stopSynthIfAny();
    track = t;
    synthOffset = 0;
    if (!t) return;
    if (t.kind === "synth") {
      audio.pause();
      audio.removeAttribute("src");
      emit("loaded", { duration: duration() });
      if (opts.autoplay) play();
      return;
    }
    audio.src = t.url;
    audio.currentTime = 0;
    emit("loaded", { duration: 0 });
    if (opts.autoplay) play();
  }

  function stopSynthIfAny() { if (synth) { try { synth.stop(); } catch (e) {} synth = null; } }

  function play() {
    if (!track) return;
    ensureCtx();
    if (ctx.state === "suspended") ctx.resume();
    if (track.kind === "synth") {
      stopSynthIfAny();
      synthStartedAt = ctx.currentTime;
      synth = createSynth(track.preset, synthOffset);
      playing = true;
      emit("play");
      startLoop();
      return;
    }
    attachMedia();
    audio.play().then(() => { playing = true; emit("play"); startLoop(); })
      .catch((e) => emit("error", e));
  }

  function pause() {
    if (track && track.kind === "synth") {
      synthOffset = currentTime();
      stopSynthIfAny();
    } else {
      audio.pause();
    }
    playing = false;
    emit("pause");
    stopLoop();
  }

  function seek(sec) {
    if (!track) return;
    const d = duration();
    sec = Math.max(0, Math.min(sec, d > 0 ? d : sec));
    if (track.kind === "synth") {
      const wasPlaying = playing;
      stopSynthIfAny();
      synthOffset = sec;
      if (wasPlaying) { synthStartedAt = ctx.currentTime; synth = createSynth(track.preset, synthOffset); }
    } else {
      try { audio.currentTime = sec; } catch (e) {}
    }
    emit("timeupdate", { current: sec, duration: d });
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (master) master.gain.value = volume;
    audio.volume = volume;
    emit("volume", volume);
  }
  function getVolume() { return volume; }

  audio.addEventListener("ended", () => { playing = false; emit("ended"); stopLoop(); });
  audio.addEventListener("loadedmetadata", () => emit("loaded", { duration: duration() }));
  audio.addEventListener("error", () => emit("error", new Error("音频加载失败：可能是格式不支持或文件已被移动")));

  /* ---------------- 频谱 ---------------- */
  function spectrum(bars) {
    if (!analyser) return new Array(bars || 20).fill(3);
    const n = bars || 20;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const out = [];
    const per = Math.floor(data.length / n) || 1;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < per; j++) sum += data[i * per + j] || 0;
      out.push(sum / per);
    }
    return out;
  }

  return {
    on, emit, load, play, pause, seek, setVolume, getVolume, spectrum, ensureCtx,
    isPlaying: () => playing,
    getTrack: () => track,
    currentTime, duration,
    toggle() { playing ? pause() : play(); },
  };
})();
