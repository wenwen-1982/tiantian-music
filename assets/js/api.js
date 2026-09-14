/* ============================================================
 * 天天音乐 · 在线接口层
 *  - ccMixter：CC 授权曲库搜索 + 音频直链
 *  - LRCLIB：LRC 歌词匹配
 *  - 下载：桌面版走主进程（Electron IPC），浏览器预览则直接打开链接
 * ============================================================ */
window.TTAPI = (function () {
  const UA_JSON = { accept: "application/json" };
  const hasDesktop = !!(window.ttDesktop && window.ttDesktop.isDesktop);
  const ccmixterCache = new Map();

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("请求超时")), ms);
      promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /* ---------------- ccMixter 搜索 ---------------- */
  async function searchCcmixter(query, limit) {
    limit = Math.max(1, Math.min(30, parseInt(limit, 10) || 10));
    const key = query + "|" + limit;
    if (ccmixterCache.has(key)) return ccmixterCache.get(key);
    const url = "https://ccmixter.org/api/query?f=json&limit=" + Math.max(limit * 2, 12) +
                "&search=" + encodeURIComponent(query);
    let items;
    try {
      const res = await withTimeout(fetch(url, { headers: UA_JSON }), 20000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      items = await res.json();
    } catch (e) {
      throw new Error("ccMixter 请求失败（浏览器预览可能被跨域策略拦截，桌面版可正常使用）：" + e.message);
    }
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const it of items) {
      if (out.length >= limit) break;
      let pick = null;
      for (const f of (it.files || [])) {
        const u = (f.download_url || "").toLowerCase();
        if (u.endsWith(".mp3")) { pick = f.download_url; break; }
        if (u.endsWith(".flac") && !pick) pick = f.download_url;
      }
      if (!pick) continue;
      out.push({
        id: "cc-" + (it.upload_id || it.upload_name || out.length),
        title: it.upload_name || "untitled",
        artist: (it.user_name || it.artist_name || "").trim() || "未知作者",
        album: "ccMixter",
        license: it.license_url || "CC",
        url: pick,
        ext: pick.toLowerCase().endsWith(".mp3") ? ".mp3" : ".flac",
        kind: "file",
        source: "ccmixter",
      });
    }
    ccmixterCache.set(key, out);
    return out;
  }

  /* ---------------- LRCLIB 歌词 ---------------- */
  async function lrcSearch(params) {
    const qs = Object.keys(params).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
    const res = await withTimeout(fetch("https://lrclib.net/api/search?" + qs, { headers: UA_JSON }), 15000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  }
  async function fetchLyrics(title, artist) {
    let hits = [];
    try {
      hits = await lrcSearch({ track_name: title, artist_name: artist || "" });
      if (!hits.length && artist) hits = await lrcSearch({ q: title + " " + artist });
      if (!hits.length) hits = await lrcSearch({ q: title });
    } catch (e) {
      return { ok: false, error: "歌词接口请求失败：" + e.message };
    }
    hits = hits.filter((h) => ((h.syncedLyrics || h.plainLyrics || "") + "").trim());
    if (!hits.length) return { ok: false, error: "LRCLIB 未匹配到歌词" };
    let list = hits;
    if (artist) {
      const m = hits.filter((h) => ((h.artistName || "") + "").toLowerCase().includes(String(artist).toLowerCase()));
      if (m.length) list = m;
    }
    const best = list[0];
    return {
      ok: true,
      synced: best.syncedLyrics || "",
      plain: best.plainLyrics || "",
      from: (best.artistName || "?") + " - " + (best.trackName || "?"),
    };
  }

  /* ---------------- 下载 ---------------- */
  function downloadTrack(track, saveDir) {
    if (hasDesktop) {
      return window.ttDesktop.download({
        url: track.url, title: track.title, artist: track.artist, ext: track.ext, saveDir: saveDir,
      });
    }
    // 浏览器预览：打开直链由浏览器下载
    const a = document.createElement("a");
    a.href = track.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.click();
    return Promise.resolve({ ok: true, file: track.title + (track.ext || ".mp3"), browser: true });
  }
  function chooseDir() {
    if (hasDesktop) return window.ttDesktop.chooseDir();
    return Promise.resolve(null);
  }
  function defaultDir() {
    if (hasDesktop) return window.ttDesktop.defaultDir();
    return Promise.resolve("浏览器默认下载目录");
  }

  return { hasDesktop, searchCcmixter, fetchLyrics, downloadTrack, chooseDir, defaultDir };
})();
