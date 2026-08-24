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
export function createMusicPlayer({ onState } = {}) {
  const audio = new Audio();
  audio.preload = "auto";
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

  audio.addEventListener("ended", () => {
    // one pick = one song: at the end, silence. Nothing auto-plays.
    const was = playing;
    state(null);
    if (was) postEvent(was, "end");
  });

  async function play(btn) {
    // btn: { song_id, audio: "music/<file>", v }
    const g = ++gen;
    try { audio.pause(); } catch {}
    state(btn.song_id);
    postEvent(btn.song_id, "play");
    const blob = await getBlob(btn.audio, btn.v);
    if (g !== gen) return;             // she picked something newer meanwhile
    releaseUrl();
    if (blob) { objectUrl = URL.createObjectURL(blob); audio.src = objectUrl; }
    else { audio.src = "/" + btn.audio; }   // last resort: straight stream
    audio.currentTime = 0;
    audio.play().catch(() => { if (g === gen) state(null); });
  }

  function stop() {
    gen++;
    const was = playing;
    try { audio.pause(); } catch {}
    state(null);
    if (was) postEvent(was, "stop");
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
    play, stop, prefetch,
    onState: onState || null,   // renderer assigns; moves the .playing marker
    playingId: () => playing,
    cached: () => cachedCount,
    _audio: audio,   // test hook: playback state assertions
  };
  return api;
}
