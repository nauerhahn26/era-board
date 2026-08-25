// music-player.js — Songs Board playback engine (spec 8/24).
// One persistent Audio element (Book Reader pattern): one pick = one song,
// silence at the end — no queue, no autoplay-next, ever. Cache-first via
// IndexedDB so songs keep playing when the network to the hub is down:
// the hub is plain HTTP, so there is no secure context for a service worker
// (same reason as board.js's localStorage recipe stash, D40) — IDB blobs are
// the offline layer. A song's cache entry is keyed by its recipe `v` (server
// file mtime); re-ingesting a slug moves `v` and refreshes the blob.
// Telemetry: fire-and-forget POST /music-event (play/stop/end) — usage
// visibility for dad via the family pool; never blocks or queues.

const DB_NAME = "era-music";
const STORE = "songs";

function idbOpen() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);   // IDB blocked: stream-only mode
  });
}
function idbGet(db, key) {
  return new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const rq = db.transaction(STORE).objectStore(STORE).get(key);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
function idbPut(db, key, val) {
  return new Promise((resolve) => {
    if (!db) { resolve(false); return; }
    try {
      const rq = db.transaction(STORE, "readwrite").objectStore(STORE).put(val, key);
      rq.onsuccess = () => resolve(true);
      rq.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}

function postEvent(songId, action) {
  try {
    fetch("/music-event", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId, action }),
    }).catch(() => {});
  } catch { /* telemetry is nice-to-have, never load-bearing */ }
}

// createMusicPlayer({ onState }) -> { play, stop, playingId, prefetch, cached }
//   onState(playingId|null) fires on every playback state change so the
//   renderer can move the `.playing` tile marker.
export function createMusicPlayer({ onState, volCap } = {}) {
  const audio = new Audio();
  audio.preload = "auto";
  // Music loudness cap (dad 8/24: quiet music for the classroom). One knob on
  // the ERAgaze Settings page (server /settings musicVolCap, % of speaker
  // volume) applies to every device; the launch URL may ALSO carry ?vol=1..100
  // (the school kiosk bat passes a floor). STRICTEST WINS. The server value is
  // remembered in localStorage so a dead network keeps the last cap, not full
  // volume. Speech is untouched — this caps the music element only.
  let urlV = null;
  try {
    const v = parseInt(new URLSearchParams(location.search).get("vol"), 10);
    if (Number.isFinite(v) && v >= 1 && v <= 100) urlV = v;
  } catch {}
  function applyCap(srvV) {
    audio.volume = Math.min(urlV ?? 100, srvV ?? 100) / 100;
  }
  function setCap(v) {
    if (typeof v !== "number" || !(v >= 1 && v <= 100)) return;
    const srvV = Math.round(v);
    try { localStorage.setItem("music:volCap", String(srvV)); } catch {}
    applyCap(srvV);   // instant, even mid-song
  }
  if (typeof volCap === "number" && volCap >= 1 && volCap <= 100) {
    setCap(volCap);
  } else {
    let srvV = null;
    try {
      const c = parseInt(localStorage.getItem("music:volCap"), 10);
      if (Number.isFinite(c) && c >= 1 && c <= 100) srvV = c;   // offline: last known cap
    } catch {}
    applyCap(srvV);
  }
  // Live-follow the ERAgaze Settings knob (dad 8/24: he changed it while the
  // board was open and nothing happened): re-read every 30s, apply mid-song.
  const capPoll = setInterval(async () => {
    try {
      const s = await (await fetch("/settings", { cache: "no-store" })).json();
      if (typeof s.musicVolCap === "number") setCap(s.musicVolCap);
    } catch { /* offline: cached cap stands */ }
  }, (window.__musicTest && window.__musicTest.capPollMs) || 30000);
  if (capPoll.unref) capPoll.unref();
  let dbP = idbOpen();
  let gen = 0;             // render-generation guard (reader.js:156 pattern)
  let playing = null;      // song_id currently playing (null = silent)
  let objectUrl = null;
  let cachedCount = 0;
  const state = (id) => { playing = id; if (api.onState) api.onState(id); };

  function releaseUrl() {
    if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch {} objectUrl = null; }
  }

  // Cache-first blob: fresh cache hit -> blob; else network -> cache -> blob;
  // network dead + stale cache -> stale blob (better than silence); else null
  // (caller falls back to streaming the URL directly).
  async function getBlob(path, v) {
    const db = await dbP;
    const hit = await idbGet(db, path);
    if (hit && hit.v === v && hit.blob) return hit.blob;
    try {
      const r = await fetch("/" + path);
      if (!r.ok) throw new Error("music " + r.status);
      const blob = await r.blob();
      idbPut(db, path, { v, blob });
      return blob;
    } catch {
      return hit && hit.blob ? hit.blob : null;
    }
  }

  // Stop remembers where she was (dad 8/24 r5): the hero resumes from there.
  // A natural end clears it — after the song finishes, the hero starts fresh.
  let resume = null;   // { id, pos, full }
  // Clip-expiry remembers separately (dad 8/24 r6): after the 40s clip runs
  // out, FULL SONG continues from right there and plays the rest — only a
  // fresh pick or a finished song forgets it. The hero still starts fresh.
  let clipEnded = null;   // { id } — position lives in the paused audio element

  audio.addEventListener("ended", () => {
    // one pick = one song: at the end, silence. Nothing auto-plays.
    const was = playing;
    resume = null;
    clipEnded = null;
    state(null);
    if (was) postEvent(was, "end");
  });

  // 40-second default clip (dad 8/24: scratch the itch at school, not the
  // whole day). clipMs comes from the recipe (clip_ms); "Full song" clears it
  // MID-PLAY without restarting — the running playback is simply un-capped.
  let clipLimitMs = null;
  audio.addEventListener("timeupdate", () => {
    if (clipLimitMs != null && audio.currentTime * 1000 >= clipLimitMs) {
      clipLimitMs = null;
      const was = playing;
      resume = null;                     // clip ran its course: hero starts fresh
      clipEnded = was ? { id: was } : null;   // ...but Full song continues from here
      try { audio.pause(); } catch {}
      state(null);                       // clip over: silence, stay on the page
      if (was) postEvent(was, "end");
    }
  });

  function clipOf(btn) {
    const t = (window.__musicTest && window.__musicTest.clipMs);
    if (typeof t === "number") return t;                 // test override
    return (typeof btn.clip_ms === "number" && btn.clip_ms > 0) ? btn.clip_ms : null;
  }

  async function play(btn, { full = false } = {}) {
    // btn: { song_id, audio: "music/<file>", v, clip_ms }
    const g = ++gen;
    try { audio.pause(); } catch {}
    resume = null;                       // a fresh pick forgets any paused spot
    clipEnded = null;
    clipLimitMs = full ? null : clipOf(btn);
    state(btn.song_id);
    postEvent(btn.song_id, full ? "full" : "play");
    const blob = await getBlob(btn.audio, btn.v);
    if (g !== gen) return;             // she picked something newer meanwhile
    releaseUrl();
    if (blob) { objectUrl = URL.createObjectURL(blob); audio.src = objectUrl; }
    else { audio.src = "/" + btn.audio; }   // last resort: straight stream
    audio.currentTime = 0;
    audio.play().catch(() => { if (g === gen) state(null); });
  }

  // "Full song": if this song's clip is ALREADY playing, authorize the rest in
  // place (no restart — dad 8/24); otherwise start it from the top, uncapped.
  function full(btn) {
    if (playing === btn.song_id) {
      if (clipLimitMs == null) return;   // already in full mode: no-op
      clipLimitMs = null;
      state(playing);                    // re-notify: UI shows "Full song ✓"
      postEvent(btn.song_id, "full");
      return;
    }
    // clip already ran out (dad r6): continue from the 40s mark, uncapped —
    // the paused element still holds the src and position
    if (clipEnded && clipEnded.id === btn.song_id && audio.src && !audio.ended) {
      clipEnded = null;
      gen++;
      clipLimitMs = null;
      state(btn.song_id);
      postEvent(btn.song_id, "full");
      audio.play().catch(() => { state(null); });
      return;
    }
    play(btn, { full: true });
  }

  function stop() {
    gen++;
    clipEnded = null;
    const was = playing;
    if (was && audio.currentTime > 0 && !audio.ended) {
      // remember the spot (and whether the whole song was authorized)
      resume = { id: was, pos: audio.currentTime, full: clipLimitMs == null };
    }
    clipLimitMs = null;
    try { audio.pause(); } catch {}
    state(null);
    if (was) postEvent(was, "stop");
  }

  // The HERO tile (the big cover art) — dad 8/24 r5: she often just LOOKS at
  // the picture while listening, so while ITS song plays a hero activation is
  // a NO-OP (never restarts). After Stop it RESUMES from where she left off
  // (same clip/full mode); from silence with nothing to resume it starts fresh.
  function heroTap(btn) {
    if (playing === btn.song_id) return;               // she's just looking
    if (resume && resume.id === btn.song_id && audio.src) {
      const r = resume;
      resume = null;
      gen++;
      clipLimitMs = r.full ? null : clipOf(btn);
      state(btn.song_id);
      postEvent(btn.song_id, "play");
      // src is still loaded from the stopped playback; position was never reset
      audio.play().catch(() => { state(null); });
      return;
    }
    play(btn);
  }

  // Background prefetch: pull every song (and cover) into IDB, one at a time —
  // after this resolves the whole board survives a dead network. Fired after
  // first render; failures are silent (retried on the next board load).
  async function prefetch(buttons) {
    const songs = (buttons || []).filter((b) => b && b.type === "song" && b.audio);
    for (const s of songs) {
      const blob = await getBlob(s.audio, s.v);
      if (blob) cachedCount++;
      if (s.image) { try { await fetch("/" + s.image); } catch {} }  // browser cache is enough for covers
    }
    try { window.dispatchEvent(new CustomEvent("music:prefetched", { detail: { cached: cachedCount, total: songs.length } })); } catch {}
    return cachedCount;
  }

  const api = {
    play, stop, full, heroTap, prefetch,
    onState: onState || null,   // renderer assigns; moves the .playing marker
    playingId: () => playing,
    isFull: () => playing != null && clipLimitMs == null,
    cached: () => cachedCount,
    _audio: audio,   // test hook: playback state assertions
  };
  return api;
}
