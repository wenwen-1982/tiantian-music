/* ============================================================
 * 天天音乐 · 主应用（界面状态 + 交互）
 * ============================================================ */
(function () {
  const L = window.TTLibrary, E = window.TTEngine, API = window.TTAPI;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  /* ---------------- 状态 ---------------- */
  const saved = L.loadState();
  const state = {
    mode: saved.mode || "order",              // order | single | shuffle
    favorites: saved.favorites || [],         // 收藏的曲目对象
    local: saved.local || [],                 // 本地导入（不含 blob，仅元信息用于展示）
    recent: saved.recent || [],
    downloads: saved.downloads || [],
    volume: typeof saved.volume === "number" ? saved.volume : 0.7,
    accent: saved.accent || "#5b67e0",
    theme: saved.theme || "dark",
    autoLrc: saved.autoLrc !== false,
    saveDir: saved.saveDir || "",
  };
  function persist() {
    // blob url 不能持久化，只保存元信息
    L.saveState({
      mode: state.mode, favorites: state.favorites,
      local: state.local.slice(0, 300), recent: state.recent.slice(0, 100),
      downloads: state.downloads.slice(0, 100), volume: state.volume,
      accent: state.accent, theme: state.theme, autoLrc: state.autoLrc, saveDir: state.saveDir,
    });
  }

  let playlist = [];            // 当前播放队列
  let currentIndex = -1;
  let currentLyrics = [];       // [{time,text}]
  let lyricsRaw = "";
  let viewStack = ["discover"];
  let onlineResults = [];
  let searchTimer = null;

  const ACCENTS = ["#5b67e0", "#7c5cf8", "#e0567b", "#e08a3c", "#3fae72", "#3a9bd6"];
  const CLOUD_BADGE = "☁";

  /* ---------------- 通用工具 ---------------- */
  function toast(msg, ms) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove("show"), ms || 2200);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function coverHtml(track, cls) {
    if (track && track.cover) return '<img src="' + track.cover + '" alt="">';
    if (track && track.kind === "synth") return "♪";
    return "♪";
  }
  function coverStyle(track) {
    const seed = track ? (track.album || track.title || "tt") : "tt";
    if (track && track.cover) return "background:#000";
    return "background:" + L.gradientFor(seed);
  }
  function setNet(text) { $("#netStatus").textContent = text; }

  /* ---------------- 主题 ---------------- */
  function applyTheme() {
    document.documentElement.style.setProperty("--accent", state.accent);
    document.documentElement.style.setProperty("--accent-2", shade(state.accent, 22));
    document.documentElement.style.setProperty("--accent-soft", hexA(state.accent, 0.16));
    document.documentElement.setAttribute("data-theme", state.theme === "light" ? "light" : "dark");
    $("#btnTheme").textContent = state.theme === "light" ? "切换为深色" : "切换为浅色";
    renderSwatches();
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.min(255, Math.max(0, v + amt)));
    return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  function renderSwatches() {
    $("#swatches").innerHTML = ACCENTS.map((c) =>
      '<div class="swatch' + (c === state.accent ? " on" : "") + '" data-c="' + c + '" style="background:' + c + '"></div>'
    ).join("");
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(name, push) {
    if (push !== false && viewStack[viewStack.length - 1] !== name) viewStack.push(name);
    $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    $("#content").scrollTop = 0;
    if (name === "discover") renderDiscover();
    if (name === "rank") renderRank();
    if (name === "online") renderOnline();
    if (name === "favorite") renderFavorite();
    if (name === "local") renderLocal();
    if (name === "recent") renderRecent();
    if (name === "download") renderDownload();
    if (name === "setting") renderSetting();
    if (name === "searchResult") renderSearchResult();
  }

  /* ---------------- 列表渲染 ---------------- */
  function trackRow(track, idx, opt) {
    opt = opt || {};
    const faved = isFaved(track);
    const isPlaying = E.getTrack() && sameSong(E.getTrack(), track);
    return '' +
      '<div class="row' + (isPlaying ? " playing" : "") + '" data-idx="' + idx + '" data-act="play" data-list="' + (opt.list || "") + '">' +
        '<div class="idx">' + (opt.showIndex === false ? "♪" : String(idx + 1).padStart(2, "0")) + "</div>" +
        '<div class="t"><div class="mini" style="' + coverStyle(track) + '">' + coverHtml(track) + "</div>" +
          '<div class="nm"><div class="n">' + esc(track.title) + (track.source === "ccmixter" ? " <span style='color:var(--text-3)'>" + CLOUD_BADGE + "</span>" : "") + "</div>" +
          '<div class="s">' + esc(track.artist || "未知歌手") + (track.album ? " · " + esc(track.album) : "") + "</div></div></div>" +
        "<div>" + esc(track.artist || "—") + "</div>" +
        "<div>" + esc(track.album || (track.kind === "synth" ? "内置合成" : "本地文件")) + "</div>" +
        '<div class="acts">' +
          (opt.download ? '<button data-act="download" data-list="' + (opt.list || "") + '" data-idx="' + idx + '" title="下载">⬇</button>' : "") +
          (opt.remove ? '<button data-act="remove" data-list="' + (opt.list || "") + '" data-idx="' + idx + '" title="移除">✕</button>' : "") +
          '<button data-act="fav" data-list="' + (opt.list || "") + '" data-idx="' + idx + '" class="' + (faved ? "on" : "") + '" title="收藏">♥</button>' +
        "</div>" +
      "</div>";
  }
  function listHead(cols) {
    return '<div class="list-head"><div style="text-align:center">#</div><div>' + (cols[0] || "标题") + "</div><div>" +
      (cols[1] || "歌手") + "</div><div>" + (cols[2] || "专辑") +
      '</div><div style="text-align:right">操作</div></div>';
  }

  function renderDiscover() {
    $("#gridPlaylists").innerHTML = L.PLAY_PRESETS.map((p, i) =>
      '<div class="card" data-act="preset" data-idx="' + i + '">' +
        '<div class="cover" style="background:' + L.gradientFor(p.name) + '">♪</div>' +
        '<div class="name">' + esc(p.name) + "</div><div class=\"meta\">" + esc(p.desc) + "</div></div>"
    ).join("");
    const daily = L.DEMO_TRACKS.slice(0, 6);
    $("#listDaily").innerHTML = listHead(["标题", "歌手", "专辑"]) + daily.map((t, i) => trackRow(t, i, { list: "daily" })).join("");
    daily._tracks = daily;
  }

  function renderRank() {
    let html = "";
    L.RANKS.forEach((r) => {
      html += '<div class="section-title">' + esc(r.name) + " <small>示例榜单</small></div>" + listHead(["标题", "歌手", "专辑"]);
      r.trackIds.forEach((id, i) => {
        const t = L.demoById(id);
        if (t) html += trackRow(t, i, { list: "rank:" + r.name });
      });
      html += '<div style="height:14px"></div>';
    });
    $("#listRank").innerHTML = html;
  }

  function renderOnline() {
    if (!onlineResults.length) {
      $("#listOnline").innerHTML = '<div class="empty"><div class="big">🌐</div><div>还没有结果，点上方关键词或使用顶部搜索框</div></div>';
      return;
    }
    $("#listOnline").innerHTML = listHead(["标题", "歌手", "来源"]) +
      onlineResults.map((t, i) => trackRow(t, i, { list: "online", download: true })).join("");
  }

  function renderFavorite() {
    if (!state.favorites.length) {
      $("#listFavorite").innerHTML = '<div class="empty"><div class="big">♥</div><div>还没有收藏歌曲</div><div>把喜欢的歌点亮爱心，就会出现在这里</div></div>';
      return;
    }
    $("#listFavorite").innerHTML = listHead(["标题", "歌手", "专辑"]) +
      state.favorites.map((t, i) => trackRow(t, i, { list: "favorite", remove: true })).join("");
  }

  function renderLocal() {
    const list = state.local;
    if (!list.length) {
      $("#listLocal").innerHTML = '<div class="empty"><div class="big">📁</div><div>本机还没有导入音乐</div>' +
        '<div>点击「导入文件」或直接把音频拖进窗口</div><button data-act="import">导入文件</button></div>';
      return;
    }
    $("#listLocal").innerHTML = listHead(["标题", "歌手", "文件"]) +
      list.map((t, i) => trackRow(t, i, { list: "local", remove: true })).join("");
  }

  function renderRecent() {
    if (!state.recent.length) {
      $("#listRecent").innerHTML = '<div class="empty"><div class="big">🕘</div><div>暂无播放记录</div></div>';
      return;
    }
    $("#listRecent").innerHTML = listHead(["标题", "歌手", "专辑"]) +
      state.recent.map((t, i) => trackRow(t, i, { list: "recent" })).join("");
  }

  function renderDownload() {
    if (!state.downloads.length) {
      $("#listDownload").innerHTML = '<div class="empty"><div class="big">⬇</div>' +
        (API.hasDesktop ? "<div>还没有下载任务，去「在线曲库」找找开放版权音乐吧</div>"
                        : "<div>浏览器预览模式不支持下载到指定目录，桌面版可用</div>") + "</div>";
      return;
    }
    $("#listDownload").innerHTML = state.downloads.map((d, i) =>
      '<div class="row" style="grid-template-columns:46px 2fr 1fr 1fr 92px">' +
        '<div class="idx">' + (i + 1) + "</div>" +
        '<div class="t"><div class="mini" style="' + L.gradientFor(d.title) + '">⬇</div><div class="nm"><div class="n">' + esc(d.title) + "</div>" +
        '<div class="s">' + esc(d.file || "") + "</div></div></div>" +
        "<div>" + esc(d.artist || "—") + "</div>" +
        '<div><div class="prog" style="height:4px;background:var(--bg-4);border-radius:2px;overflow:hidden">' +
        '<div style="height:100%;width:' + (d.progress || 0) + "%;background:var(--accent)\"></div></div>" +
        '<div style="font-size:11.5px;color:var(--text-3)">' + esc(d.state || "") + "</div></div>" +
        '<div class="acts">' + (d.state === "完成" && API.hasDesktop ? '<button data-act="openfile" data-idx="' + i + '" title="打开位置">📂</button>' : "") + "</div>" +
      "</div>"
    ).join("");
  }

  function renderSetting() {
    $("#btnMode").textContent = modeName();
    $("#volRange").value = Math.round(state.volume * 100);
    $("#volText").textContent = Math.round(state.volume * 100) + "%";
    $("#swAutoLrc").classList.toggle("on", state.autoLrc);
    $("#swAutoPlay").classList.toggle("on", false);
    renderSwatches();
  }
  function renderSearchResult() {
    const host = $("#listSearch");
    if (!host) return;
  }

  /* ---------------- 播放逻辑 ---------------- */
  function sameSong(a, b) {
    if (!a || !b) return false;
    return a.id === b.id || (a.title === b.title && a.artist === b.artist && a.url === b.url);
  }
  function isFaved(track) { return state.favorites.some((f) => sameSong(f, track)); }

  function playTrack(track, list, index) {
    if (list) { playlist = list.slice(); currentIndex = typeof index === "number" ? index : playlist.findIndex((t) => sameSong(t, track)); }
    else if (!playlist.some((t) => sameSong(t, track))) { playlist = playlist.concat([track]); currentIndex = playlist.length - 1; }
    else { currentIndex = playlist.findIndex((t) => sameSong(t, track)); }

    E.load(track, { autoplay: true });
    updateNowBar(track);
    addRecent(track);
    renderQueue();
    prepareLyrics(track);
    refreshPlayingRows();
    $("#player").classList.add("playing");
    setNet(track.source === "ccmixter" ? "在线播放" : "本地播放");
  }
  function addRecent(track) {
    if (track.source === "ccmixter") return;
    state.recent = [track].concat(state.recent.filter((t) => !sameSong(t, track))).slice(0, 100);
    persist();
    updateBadges();
    if ($("#view-recent").classList.contains("active")) renderRecent();
  }
  function playFrom(listName, idx) {
    const lists = {
      daily: L.DEMO_TRACKS.slice(0, 6),
      favorite: state.favorites,
      local: state.local,
      recent: state.recent,
      online: onlineResults,
    };
    if (listName && listName.indexOf("rank:") === 0) {
      const r = L.RANKS.find((x) => x.name === listName.slice(5));
      const arr = r ? r.trackIds.map(L.demoById).filter(Boolean) : [];
      return playTrack(arr[idx], arr, idx);
    }
    const arr = lists[listName] || playlist;
    if (!arr[idx]) return;
    playTrack(arr[idx], arr, idx);
  }
  function next(auto) {
    if (!playlist.length) return;
    if (state.mode === "single" && auto) { E.seek(0); E.play(); return; }
    if (state.mode === "shuffle" && playlist.length > 1) {
      let n = currentIndex;
      while (n === currentIndex) n = Math.floor(Math.random() * playlist.length);
      currentIndex = n;
    } else {
      currentIndex = (currentIndex + 1) % playlist.length;
    }
    playTrack(playlist[currentIndex], playlist, currentIndex);
  }
  function prev() {
    if (!playlist.length) return;
    currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
    playTrack(playlist[currentIndex], playlist, currentIndex);
  }
  function modeName() { return state.mode === "single" ? "单曲循环" : state.mode === "shuffle" ? "随机播放" : "顺序播放"; }
  function cycleMode() {
    state.mode = state.mode === "order" ? "single" : state.mode === "single" ? "shuffle" : "order";
    persist();
    toast("播放模式：" + modeName());
    renderSetting();
  }

  function updateNowBar(track) {
    $("#pTitle").textContent = track.title;
    $("#pSub").textContent = (track.artist || "未知歌手") + (track.album ? " · " + track.album : "");
    const c = $("#pCover");
    c.innerHTML = coverHtml(track);
    c.style.background = coverStyle(track);
    $("#npCover").innerHTML = coverHtml(track);
    $("#npCover").style.background = coverStyle(track);
    $("#npTitle").textContent = track.title;
    $("#npSub").textContent = (track.artist || "未知歌手") + (track.album ? " · " + track.album : "");
    $("#pFav").classList.toggle("on", isFaved(track));
    const p = track.preset;
    $("#tDur").textContent = p ? L.fmtTime(p.duration) : "00:00";
  }
  function refreshPlayingRows() {
    const cur = E.getTrack();
    $$(".row").forEach((row) => {
      const list = row.dataset.list, idx = parseInt(row.dataset.idx, 10);
      let t = null;
      if (list === "daily") t = L.DEMO_TRACKS.slice(0, 6)[idx];
      else if (list === "favorite") t = state.favorites[idx];
      else if (list === "local") t = state.local[idx];
      else if (list === "recent") t = state.recent[idx];
      else if (list === "online") t = onlineResults[idx];
      else if (list && list.indexOf("rank:") === 0) {
        const r = L.RANKS.find((x) => x.name === list.slice(5));
        t = r ? L.demoById(r.trackIds[idx]) : null;
      }
      row.classList.toggle("playing", !!(t && cur && sameSong(t, cur)));
    });
  }

  function updateBadges() {
    $("#badgeFav").textContent = state.favorites.length;
    $("#badgeLocal").textContent = state.local.length;
  }

  function renderQueue() {
    $("#queueCount").textContent = playlist.length;
    $("#queueList").innerHTML = playlist.map((t, i) =>
      '<div class="qi' + (i === currentIndex ? " playing" : "") + '" data-act="queue" data-idx="' + i + '">' +
      "<span>" + (i + 1) + ".</span><span>" + esc(t.title) + '</span><span style="margin-left:auto;color:var(--text-3)">' + esc(t.artist || "") + "</span></div>"
    ).join("") || '<div style="color:var(--text-3);padding:8px">队列为空</div>';
  }

  /* ---------------- 歌词 ---------------- */
  function prepareLyrics(track) {
    currentLyrics = [];
    lyricsRaw = "";
    if (track.lyricsText) { lyricsRaw = track.lyricsText; currentLyrics = L.parseLRC(track.lyricsText) || []; }
    if (!currentLyrics.length && track.kind === "synth") {
      // 内置曲目：生成段落提示
      const d = track.preset.duration;
      const marks = [[0, "♪ 前奏"], [d * 0.12, "♪ 主题进入"], [d * 0.4, "♪ 副歌"], [d * 0.66, "♪ 间奏"], [d * 0.85, "♪ 尾声"]];
      lyricsRaw = marks.map((m) => "[" + toLrcTime(m[0]) + "]" + m[1]).join("\n");
      currentLyrics = L.parseLRC(lyricsRaw);
    }
    renderLyrics();
    if (!currentLyrics.length && state.autoLrc && track.title && track.kind === "file") autoFetchLyrics(track);
  }
  function toLrcTime(sec) {
    const m = Math.floor(sec / 60), s = (sec % 60).toFixed(2).padStart(5, "0");
    return String(m).padStart(2, "0") + ":" + s;
  }
  function renderLyrics() {
    if (!currentLyrics.length) {
      $("#lyrics").innerHTML = '<div style="color:var(--text-3);padding:20px 0">暂无歌词' +
        '<div style="margin-top:12px;display:flex;gap:10px"><button class="btn" data-act="fetch-lrc">联网匹配歌词</button>' +
        '<button class="btn" data-act="load-lrc">导入 LRC 文件</button></div></div>';
      return;
    }
    $("#lyrics").innerHTML = currentLyrics.map((l, i) => '<div class="ln" data-i="' + i + '">' + esc(l.text) + "</div>").join("");
  }
  function syncLyrics(t) {
    if (!currentLyrics.length) return;
    let idx = -1;
    for (let i = 0; i < currentLyrics.length; i++) if (t >= currentLyrics[i].time) idx = i;
    const nodes = $("#lyrics").children;
    for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle("on", i === idx);
    if (idx >= 0 && nodes[idx]) {
      const el = nodes[idx];
      const box = $("#lyrics");
      const target = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
      box.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }
  async function autoFetchLyrics(track) {
    setNet("匹配歌词…");
    const r = await API.fetchLyrics(track.title, track.artist);
    setNet("就绪");
    if (!r.ok) { toast(r.error); return; }
    lyricsRaw = r.synced || r.plain;
    currentLyrics = L.parseLRC(r.synced) || [];
    if (!currentLyrics.length && r.plain) currentLyrics = r.plain.split("\n").filter(Boolean).map((x, i) => ({ time: i * 6, text: x }));
    track.lyricsText = lyricsRaw;
    renderLyrics();
    toast("歌词已匹配：" + r.from);
  }

  /* ---------------- 本地导入 ---------------- */
  const AUDIO_RE = /\.(mp3|flac|m4a|wav|ogg|aac|wma|opus)$/i;

  function makeLocalTrack(file) {
    return {
      id: "local-" + file.name + "-" + file.size,
      title: file.name.replace(/\.[^.]+$/, ""),
      artist: "未知歌手",
      album: "本地文件",
      kind: "file",
      url: URL.createObjectURL(file),
      fileName: file.name,
      size: file.size,
    };
  }
  function readID3For(track, file) {
    return new Promise((resolve) => {
      if (!/\.mp3$/i.test(file.name) || file.size < 128) return resolve(track);
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const tags = L.parseID3(fr.result);
          if (tags.title) track.title = tags.title;
          if (tags.artist) track.artist = tags.artist;
          if (tags.album) track.album = tags.album;
          if (tags.picture) track.cover = tags.picture;
        } catch (e) {}
        resolve(track);
      };
      fr.onerror = () => resolve(track);
      fr.readAsArrayBuffer(file.slice(0, Math.min(file.size, 1024 * 1024 * 4)));
    });
  }
  async function importFiles(files) {
    const arr = Array.prototype.filter.call(files, (f) => AUDIO_RE.test(f.name) || (f.type || "").indexOf("audio") === 0);
    if (!arr.length) { toast("没有找到可导入的音频文件"); return; }
    setNet("解析标签…");
    const added = [];
    for (const f of arr) {
      const t = makeLocalTrack(f);
      try { await readID3For(t, f); } catch (e) {}
      added.push(t);
    }
    state.local = added.concat(state.local);
    persist();
    updateBadges();
    setNet("就绪");
    renderLocal();
    switchView("local");
    toast("已导入 " + added.length + " 首");
  }

  /* ---------------- 在线搜索 ---------------- */
  async function doOnlineSearch(q) {
    if (!q) return;
    switchView("online");
    setNet("联网搜索中…");
    $("#onlineTip").textContent = "搜索：" + q;
    $("#listOnline").innerHTML = '<div class="empty"><span class="spinner"></span> 正在请求 ccMixter…</div>';
    try {
      onlineResults = await API.searchCcmixter(q, 12);
      renderOnline();
      setNet("就绪");
      toast(onlineResults.length ? "找到 " + onlineResults.length + " 首 CC 授权曲目" : "没有找到结果，换个关键词试试");
    } catch (e) {
      onlineResults = [];
      $("#listOnline").innerHTML = '<div class="empty"><div class="big">⚠</div><div>' + esc(e.message) + "</div></div>";
      setNet("请求失败");
    }
  }
  function localSearch(q) {
    if (!q) return;
    const hit = state.local.filter((t) => (t.title + t.artist + t.album).toLowerCase().includes(q.toLowerCase()));
    const demo = L.DEMO_TRACKS.filter((t) => (t.title + t.artist).toLowerCase().includes(q.toLowerCase()));
    if (!hit.length && !demo.length) { doOnlineSearch(q); return; }
    const all = demo.concat(hit);
    switchView("discover", false);
    $("#content").innerHTML = "";
    toast("本地/内置命中 " + all.length + " 首，回车可同时联网搜索");
    playlist = all;
    currentIndex = 0;
    playTrack(all[0], all, 0);
  }

  /* ---------------- 下载 ---------------- */
  async function downloadFromOnline(idx) {
    const t = onlineResults[idx];
    if (!t) return;
    if (!state.saveDir) state.saveDir = await API.defaultDir();
    const job = { title: t.title, artist: t.artist, file: "", progress: 0, state: "准备", url: t.url };
    state.downloads.unshift(job);
    renderDownload();
    persist();
    toast("开始下载：" + t.title);
    const res = await API.downloadTrack(t, state.saveDir);
    if (res && res.ok) {
      job.progress = 100;
      job.state = res.browser ? "已交给浏览器" : "完成";
      job.file = res.file || "";
      if ($("#view-download").classList.contains("active")) switchView("download");
      toast("下载完成：" + (res.file || t.title));
    } else {
      job.state = "失败";
      toast("下载失败：" + ((res && res.error) || "未知错误"));
    }
    renderDownload();
    persist();
  }
  if (API.hasDesktop) {
    window.ttDesktop.onProgress((p) => {
      const job = state.downloads[0];
      if (!job) return;
      if (p.total) job.progress = Math.round((p.received / p.total) * 100);
      job.state = "下载中 " + job.progress + "%";
      if ($("#view-download").classList.contains("active")) renderDownload();
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $$(".nav-item").forEach((n) => n.addEventListener("click", () => switchView(n.dataset.view)));
    $("#btnBack").addEventListener("click", () => {
      if (viewStack.length > 1) { viewStack.pop(); switchView(viewStack[viewStack.length - 1], false); }
    });

    // 全局点击代理
    document.addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-act]");
      if (!el) return;
      const act = el.dataset.act, idx = parseInt(el.dataset.idx, 10);
      if (act === "play") { playFrom(el.dataset.list, idx); }
      else if (act === "fav") { ev.stopPropagation(); toggleFav(el.dataset.list, idx); }
      else if (act === "download") { ev.stopPropagation(); downloadFromOnline(idx); }
      else if (act === "remove") { ev.stopPropagation(); removeFrom(el.dataset.list, idx); }
      else if (act === "preset") { const p = L.PLAY_PRESETS[idx]; const arr = p.trackIds.map(L.demoById).filter(Boolean); playTrack(arr[0], arr, 0); toast("已播放：" + p.name); }
      else if (act === "queue") { playTrack(playlist[idx], playlist, idx); }
      else if (act === "import") { $("#filePicker").click(); }
      else if (act === "fetch-lrc") { const t = E.getTrack(); if (t) autoFetchLyrics(t); }
      else if (act === "load-lrc") { pickLrcFile(); }
      else if (act === "openfile") { if (API.hasDesktop && window.ttDesktop.openPath) window.ttDesktop.openPath(state.saveDir || ""); }
      else if (el.classList.contains("swatch")) { state.accent = el.dataset.c; applyTheme(); persist(); }
    });

    // 播放控制
    $("#btnPlay").addEventListener("click", () => {
      if (!E.getTrack()) { const t = L.DEMO_TRACKS[0]; playTrack(t, L.DEMO_TRACKS.slice(0, 6), 0); return; }
      E.toggle();
    });
    $("#btnPrev").addEventListener("click", prev);
    $("#btnNext").addEventListener("click", () => next(false));
    $("#btnModeIcon").addEventListener("click", cycleMode);
    $("#btnNow").addEventListener("click", () => $("#nowPanel").classList.add("show"));
    $("#npClose").addEventListener("click", () => $("#nowPanel").classList.remove("show"));
    $("#btnQueue").addEventListener("click", () => $("#queueDrawer").classList.toggle("show"));
    $("#queueClear").addEventListener("click", () => { playlist = []; currentIndex = -1; renderQueue(); toast("队列已清空"); });

    // 进度条 / 音量条拖动
    dragBar($("#barProgress"), (r) => { const d = E.duration(); if (d) E.seek(d * r); });
    dragBar($("#barVolume"), (r) => { state.volume = r; E.setVolume(r); persist(); renderSetting(); });
    $("#btnVol").addEventListener("click", () => { const v = state.volume > 0 ? 0 : 0.7; state.volume = v; E.setVolume(v); persist(); renderSetting(); });

    // 收藏
    $("#pFav").addEventListener("click", () => { const t = E.getTrack(); if (t) { toggleFavObj(t); } });

    // 导入
    $("#btnImport").addEventListener("click", () => $("#filePicker").click());
    $("#bannerImport").addEventListener("click", () => $("#filePicker").click());
    $("#filePicker").addEventListener("change", (e) => { importFiles(e.target.files); e.target.value = ""; });
    $("#dirPicker").addEventListener("change", (e) => { importFiles(e.target.files); e.target.value = ""; });
    $("#btnImportDir").addEventListener("click", () => {
      if (API.hasDesktop && window.ttDesktop.pickFiles) {
        window.ttDesktop.pickFiles().then((files) => {
          if (!files || !files.length) return;
          const tracks = files.map((f) => ({
            id: "local-" + f.path, title: f.name.replace(/\.[^.]+$/, ""), artist: "未知歌手",
            album: "本地文件", kind: "file", url: f.url, fileName: f.name,
          }));
          state.local = tracks.concat(state.local);
          persist(); updateBadges(); renderLocal(); switchView("local");
          toast("已导入 " + tracks.length + " 首");
        });
      } else {
        $("#dirPicker").click();
      }
    });
    $("#btnScanDir").addEventListener("click", () => {
      if (!API.hasDesktop || !window.ttDesktop.scanDir) { toast("浏览器预览不支持扫描磁盘目录，请用桌面版或「导入文件夹」"); return; }
      window.ttDesktop.scanDir().then((files) => {
        if (!files || !files.length) return;
        const tracks = files.map((f) => ({
          id: "local-" + f.path, title: f.name.replace(/\.[^.]+$/, ""), artist: "未知歌手",
          album: "本地文件", kind: "file", url: f.url, fileName: f.name,
        }));
        state.local = tracks.concat(state.local);
        persist(); updateBadges(); renderLocal(); switchView("local");
        toast("扫描到 " + tracks.length + " 首音频");
      });
    });
    $("#btnClearLocal").addEventListener("click", () => {
      if (!confirm("确定清空本地音乐列表吗？不会删除磁盘文件。")) return;
      state.local = []; persist(); updateBadges(); renderLocal(); toast("已清空列表");
    });

    // 拖拽导入
    let dragDepth = 0;
    window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("#dropMask").classList.add("show"); });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) => { dragDepth--; if (dragDepth <= 0) { dragDepth = 0; $("#dropMask").classList.remove("show"); } });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      $("#dropMask").classList.remove("show");
      if (!e.dataTransfer) return;
      const files = e.dataTransfer.files;
      if (files && files.length) importFiles(files);
    });

    // 搜索
    $("#searchGo").addEventListener("click", () => {
      const q = $("#searchInput").value.trim();
      if (q) doOnlineSearch(q);
    });
    $("#searchInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const q = e.target.value.trim();
        if (q) doOnlineSearch(q);
      }
    });
    $("#searchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      const q = e.target.value.trim();
      if (q.length >= 2) searchTimer = setTimeout(() => localSearch(q), 700);
    });
    $$("#view-online [data-chip]").forEach((b) => b.addEventListener("click", () => doOnlineSearch(b.dataset.chip)));

    // 设置
    $("#btnTheme").addEventListener("click", () => { state.theme = state.theme === "light" ? "dark" : "light"; applyTheme(); persist(); });
    $("#btnMode").addEventListener("click", cycleMode);
    $("#volRange").addEventListener("input", (e) => { state.volume = e.target.value / 100; E.setVolume(state.volume); $("#volText").textContent = e.target.value + "%"; persist(); });
    $("#swAutoLrc").addEventListener("click", () => { state.autoLrc = !state.autoLrc; $("#swAutoLrc").classList.toggle("on", state.autoLrc); persist(); });
    $("#swAutoPlay").addEventListener("click", () => toast("该功能仅桌面版可用"));
    $("#btnAbout").addEventListener("click", () => toast("天天音乐 1.0.0 · 本地播放 + 开放版权曲库 + 歌词同步", 3200));

    // 快捷键
    window.addEventListener("keydown", (e) => {
      if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); if (E.getTrack()) E.toggle(); else playTrack(L.DEMO_TRACKS[0], L.DEMO_TRACKS.slice(0, 6), 0); }
      else if (e.code === "ArrowRight" && e.ctrlKey) next(false);
      else if (e.code === "ArrowLeft" && e.ctrlKey) prev();
      else if (e.code === "ArrowRight") E.seek(E.currentTime() + 5);
      else if (e.code === "ArrowLeft") E.seek(E.currentTime() - 5);
      else if (e.code === "ArrowUp") { state.volume = Math.min(1, state.volume + 0.05); E.setVolume(state.volume); persist(); renderSetting(); }
      else if (e.code === "ArrowDown") { state.volume = Math.max(0, state.volume - 0.05); E.setVolume(state.volume); persist(); renderSetting(); }
      else if (e.code === "Escape") $("#nowPanel").classList.remove("show");
    });

    // 桌面窗口控制
    if (API.hasDesktop && window.ttDesktop.win) {
      $("#winControls").style.display = "flex";
      $("#winMin").addEventListener("click", () => window.ttDesktop.win("min"));
      $("#winMax").addEventListener("click", () => window.ttDesktop.win("max"));
      $("#winClose").addEventListener("click", () => window.ttDesktop.win("close"));
    }

    // 引擎事件
    E.on("play", () => { $("#iconPlay").innerHTML = '<path d="M7 5h4v14H7V5zm6 0h4v14h-4V5z"/>'; renderQueue(); refreshPlayingRows(); });
    E.on("pause", () => { $("#iconPlay").innerHTML = '<path d="M8 5l12 7-12 7V5z"/>'; });
    E.on("error", (err) => toast(err.message || "播放出错"));
    E.on("ended", () => next(true));
    E.on("timeupdate", (d) => {
      $("#tCur").textContent = L.fmtTime(d.current);
      $("#tDur").textContent = L.fmtTime(d.duration);
      $("#fillProgress").style.width = d.duration ? (d.current / d.duration) * 100 + "%" : "0%";
      syncLyrics(d.current);
    });
    E.on("loaded", (d) => { if (d.duration) $("#tDur").textContent = L.fmtTime(d.duration); });

    // 频谱动画
    const vis = $("#visualizer");
    vis.innerHTML = new Array(16).fill("<i></i>").join("");
    (function tick() {
      const data = E.spectrum(16);
      const bars = vis.children;
      for (let i = 0; i < bars.length; i++) bars[i].style.height = Math.max(3, Math.min(22, (data[i] / 255) * 26)) + "px";
      requestAnimationFrame(tick);
    })();
  }

  function dragBar(bar, cb) {
    let dragging = false;
    function ratio(ev) {
      const r = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    }
    bar.addEventListener("mousedown", (e) => {
      dragging = true;
      cb(ratio(e));
      const mv = (ev2) => { if (dragging) cb(ratio(ev2)); };
      const up = () => { dragging = false; document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    });
  }
  function toggleFav(list, idx) {
    const map = { favorite: state.favorites, local: state.local, recent: state.recent, daily: L.DEMO_TRACKS.slice(0, 6), online: onlineResults };
    let t = map[list] && map[list][idx];
    if (!t && list && list.indexOf("rank:") === 0) {
      const r = L.RANKS.find((x) => x.name === list.slice(5));
      t = r ? L.demoById(r.trackIds[idx]) : null;
    }
    if (t) toggleFavObj(t);
  }
  function toggleFavObj(track) {
    if (isFaved(track)) {
      state.favorites = state.favorites.filter((f) => !sameSong(f, track));
      toast("已取消收藏");
    } else {
      state.favorites = [track].concat(state.favorites);
      toast("已加入收藏");
    }
    persist(); updateBadges(); refreshPlayingRows();
    const cur = E.getTrack();
    if (cur) $("#pFav").classList.toggle("on", isFaved(cur));
    if ($("#view-favorite").classList.contains("active")) renderFavorite();
    $$(".row").forEach((row) => {
      const list = row.dataset.list, idx = parseInt(row.dataset.idx, 10);
      const map = { favorite: state.favorites, local: state.local, recent: state.recent, daily: L.DEMO_TRACKS.slice(0, 6), online: onlineResults };
      let t = map[list] && map[list][idx];
      if (!t && list && list.indexOf("rank:") === 0) {
        const r = L.RANKS.find((x) => x.name === list.slice(5));
        t = r ? L.demoById(r.trackIds[idx]) : null;
      }
      const btn = row.querySelector('[data-act="fav"]');
      if (btn && t) btn.classList.toggle("on", isFaved(t));
    });
  }
  function removeFrom(list, idx) {
    if (list === "local") { state.local.splice(idx, 1); persist(); updateBadges(); renderLocal(); toast("已从列表移除"); }
    else if (list === "favorite") { state.favorites.splice(idx, 1); persist(); updateBadges(); renderFavorite(); toast("已取消收藏"); }
  }
  function pickLrcFile() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".lrc,.txt";
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        lyricsRaw = fr.result;
        currentLyrics = L.parseLRC(lyricsRaw);
        if (!currentLyrics.length) currentLyrics = String(lyricsRaw).split("\n").filter(Boolean).map((x, i) => ({ time: i * 6, text: x }));
        const t = E.getTrack();
        if (t) t.lyricsText = lyricsRaw;
        renderLyrics();
        toast("已载入歌词文件");
      };
      fr.readAsText(f, "utf-8");
    };
    inp.click();
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    applyTheme();
    E.setVolume(state.volume);
    updateBadges();
    bind();
    switchView("discover", false);
    renderQueue();
    renderDownload();
    // 恢复"最近播放"到队列
    if (state.recent.length) { playlist = state.recent.slice(); currentIndex = -1; renderQueue(); }
    setNet(API.hasDesktop ? "桌面版" : "浏览器预览");
    console.log("天天音乐已启动", { desktop: API.hasDesktop, demo: L.DEMO_TRACKS.length });
  }
  document.addEventListener("DOMContentLoaded", init);
})();
