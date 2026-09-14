/* ============================================================
 * 天天音乐 · 曲库 & 解析工具
 *  - 内置合成器曲目（无需任何音频文件即可试听）
 *  - ID3v2 标签 / 封面解析（本地 mp3）
 *  - LRC 歌词解析
 *  - 本地存储读写
 * ============================================================ */
window.TTLibrary = (function () {
  const SCALE_MINOR_PENTA = [0, 3, 5, 7, 10];
  const SCALE_MAJOR_PENTA = [0, 2, 4, 7, 9];
  const SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const SCALE_DORIAN = [0, 2, 3, 5, 7, 9, 10];

  function preset(o) {
    return Object.assign({
      bpm: 90, root: 57, scale: SCALE_MAJOR_PENTA, progress: [0, 5, 3, 4],
      duration: 150, seed: 7, gain: 0.3, arp: true, drums: true, mood: ["#5b67e0", "#8f6df8"],
    }, o);
  }

  const DEMO_TRACKS = [
    { id: "s1", title: "星夜漫游", artist: "天天音乐 · 合成器", album: "夜航集", kind: "synth",
      preset: preset({ bpm: 84, root: 57, scale: SCALE_MINOR_PENTA, progress: [0, 4, 5, 3], seed: 11, gain: 0.3, mood: ["#3a4bb8", "#7c5cf8"] }) },
    { id: "s2", title: "晨光微亮", artist: "天天音乐 · 合成器", album: "清晨集", kind: "synth",
      preset: preset({ bpm: 96, root: 60, scale: SCALE_MAJOR_PENTA, progress: [0, 3, 4, 5], seed: 23, gain: 0.28, mood: ["#f2994a", "#f2c94c"] }) },
    { id: "s3", title: "城市雨夜", artist: "天天音乐 · 合成器", album: "雨日集", kind: "synth",
      preset: preset({ bpm: 72, root: 50, scale: SCALE_DORIAN, progress: [0, 5, 3, 4], seed: 37, gain: 0.3, mood: ["#2d3a5e", "#4b6cb7"] }) },
    { id: "s4", title: "午后咖啡馆", artist: "天天音乐 · 合成器", album: "午后集", kind: "synth",
      preset: preset({ bpm: 104, root: 53, scale: SCALE_MAJOR_PENTA, progress: [0, 4, 3, 5], seed: 41, gain: 0.26, mood: ["#b06d3a", "#e0a96d"] }) },
    { id: "s5", title: "深海回声", artist: "天天音乐 · 合成器", album: "深蓝集", kind: "synth",
      preset: preset({ bpm: 66, root: 45, scale: SCALE_MINOR_PENTA, progress: [0, 3, 5, 4], seed: 53, gain: 0.32, mood: ["#12384a", "#2c7a8a"] }) },
    { id: "s6", title: "长廊尽头", artist: "天天音乐 · 合成器", album: "夜航集", kind: "synth",
      preset: preset({ bpm: 88, root: 55, scale: SCALE_MAJOR, progress: [0, 5, 1, 4], seed: 67, gain: 0.28, mood: ["#5b3aa0", "#9b6dd6"] }) },
    { id: "s7", title: "轻舟慢桨", artist: "天天音乐 · 合成器", album: "山水集", kind: "synth",
      preset: preset({ bpm: 78, root: 62, scale: SCALE_MAJOR_PENTA, progress: [0, 3, 5, 4], seed: 79, gain: 0.27, mood: ["#3f7d5a", "#7fbf8f"] }) },
    { id: "s8", title: "霓虹漫步", artist: "天天音乐 · 合成器", album: "都市集", kind: "synth",
      preset: preset({ bpm: 112, root: 58, scale: SCALE_MINOR_PENTA, progress: [0, 4, 5, 4], seed: 91, gain: 0.26, mood: ["#c0392b", "#e56b8a"] }) },
  ];

  const PLAY_PRESETS = [
    { id: "p1", name: "夜航集 · 深夜独处", desc: "8 首", color: 0, trackIds: ["s1", "s6", "s5", "s3"] },
    { id: "p2", name: "清晨清醒指南", desc: "6 首", color: 1, trackIds: ["s2", "s4", "s7", "s1"] },
    { id: "p3", name: "专注工作流", desc: "5 首", color: 2, trackIds: ["s4", "s7", "s2", "s6"] },
    { id: "p4", name: "都市夜行", desc: "7 首", color: 3, trackIds: ["s8", "s3", "s5", "s1"] },
  ];

  const RANKS = [
    { name: "天天飙升榜", trackIds: ["s8", "s1", "s4", "s2", "s6"] },
    { name: "天天热歌榜", trackIds: ["s1", "s3", "s7", "s5", "s2"] },
    { name: "合成器新声榜", trackIds: ["s6", "s4", "s8", "s7", "s3"] },
  ];

  /* ---------------- 工具 ---------------- */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Math.abs(h);
  }
  const PALETTES = [
    ["#5b67e0", "#8f6df8"], ["#f2994a", "#f2c94c"], ["#3f7d5a", "#7fbf8f"],
    ["#c0392b", "#e56b8a"], ["#2d3a5e", "#4b6cb7"], ["#5b3aa0", "#9b6dd6"],
    ["#12384a", "#2c7a8a"], ["#b06d3a", "#e0a96d"], ["#4a55c7", "#7c8cf8"],
  ];
  function gradientFor(seedStr) {
    const p = PALETTES[hash(String(seedStr)) % PALETTES.length];
    return "linear-gradient(135deg," + p[0] + "," + p[1] + ")";
  }
  function colorFor(seedStr) {
    const p = PALETTES[hash(String(seedStr)) % PALETTES.length];
    return p[0];
  }

  /* ---------------- ID3v2 解析（本地 mp3） ---------------- */
  function decodeText(bytes) {
    if (!bytes || !bytes.length) return "";
    let enc = bytes[0], body = bytes.subarray(1);
    try {
      if (enc === 0) return new TextDecoder("latin1").decode(body).replace(/\0.*$/, "").trim();
      if (enc === 1) return new TextDecoder("utf-16").decode(body).replace(/\0.*$/, "").trim();
      if (enc === 2) return new TextDecoder("utf-16be").decode(body).replace(/\0.*$/, "").trim();
      return new TextDecoder("utf-8").decode(body).replace(/\0.*$/, "").trim();
    } catch (e) { return ""; }
  }
  function parseID3(buffer) {
    const view = new DataView(buffer);
    const out = { title: "", artist: "", album: "", picture: "" };
    if (buffer.byteLength < 10) return out;
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return out;
    const ver = view.getUint8(3);
    const size = ((view.getUint8(6) & 0x7f) << 21) | ((view.getUint8(7) & 0x7f) << 14) |
                 ((view.getUint8(8) & 0x7f) << 7) | (view.getUint8(9) & 0x7f);
    let pos = 10;
    const end = Math.min(10 + size, buffer.byteLength);
    while (pos + 10 < end) {
      const id = String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      let fsize;
      if (ver === 4) {
        fsize = ((view.getUint8(pos + 4) & 0x7f) << 21) | ((view.getUint8(pos + 5) & 0x7f) << 14) |
                ((view.getUint8(pos + 6) & 0x7f) << 7) | (view.getUint8(pos + 7) & 0x7f);
      } else {
        fsize = (view.getUint8(pos + 4) << 24) | (view.getUint8(pos + 5) << 16) |
                (view.getUint8(pos + 6) << 8) | view.getUint8(pos + 7);
      }
      const dStart = pos + 10, dEnd = dStart + fsize;
      if (fsize <= 0 || dEnd > buffer.byteLength) break;
      const data = new Uint8Array(buffer, dStart, fsize);
      if (id === "TIT2") out.title = decodeText(data);
      else if (id === "TPE1") out.artist = decodeText(data);
      else if (id === "TALB") out.album = decodeText(data);
      else if (id === "APIC") {
        let p = 1;
        while (p < data.length && data[p] !== 0) p++;
        const mime = new TextDecoder("latin1").decode(data.subarray(1, p));
        p++;
        const picType = data[p]; p++;
        while (p < data.length && data[p] !== 0) p++;
        p++;
        const pic = data.subarray(p);
        if (pic.length > 100) {
          try {
            let bin = "";
            for (let i = 0; i < pic.length; i++) bin += String.fromCharCode(pic[i]);
            out.picture = "data:" + (mime || "image/jpeg") + ";base64," + btoa(bin);
          } catch (e) {}
        }
      }
      pos = dEnd;
    }
    return out;
  }

  /* ---------------- LRC 解析 ---------------- */
  function parseLRC(text) {
    if (!text) return [];
    const lines = [];
    text.split(/\r?\n/).forEach((raw) => {
      const m = raw.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)/);
      if (!m) return;
      const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseInt(m[3].padEnd(3, "0"), 10) / 1000 : 0);
      const txt = (m[4] || "").trim();
      if (txt) lines.push({ time: t, text: txt });
    });
    return lines.sort((a, b) => a.time - b.time);
  }
  function looksLikeLRC(text) { return /\[\d{1,2}:\d{1,2}/.test(text || ""); }

  /* ---------------- 本地存储 ---------------- */
  const KEY = "ttmusic.state.v1";
  function loadState() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function saveState(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
  }

  return {
    DEMO_TRACKS, PLAY_PRESETS, RANKS, PALETTES,
    preset, fmtTime, gradientFor, colorFor, hash,
    parseID3, parseLRC, looksLikeLRC, loadState, saveState,
    demoById(id) { return DEMO_TRACKS.find((t) => t.id === id) || null; },
  };
})();
