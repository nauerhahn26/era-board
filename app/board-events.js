// board-events.js — outfit pick telemetry (Phase 2, D49). Fire-and-forget:
// enqueue is synchronous, the POST is async — her activation is never delayed
// and a failed send never surfaces. Offline events queue in localStorage and
// flush when the server answers again (same resilience posture as the recipe
// cache; no service worker per D40). The 6:35 generator reads the resulting
// history.json events to learn her real favorites.
//
// Injectable factory so node tests can drive it with a fake fetch/storage;
// the renderer creates one instance per mount with the defaults.

const LS_QUEUE = "board:outfitEvents";
const QUEUE_CAP = 50; // oldest dropped first — telemetry, never precious

export function createOutfitEvents({ fetchFn, storage, retryMs = 30000 } = {}) {
  const doFetch = fetchFn || ((...a) => fetch(...a));
  const store = storage || window.localStorage;
  let timer = null;
  let flushing = false;

  function load() {
    try {
      const q = JSON.parse(store.getItem(LS_QUEUE));
      return Array.isArray(q) ? q : [];
    } catch { return []; }
  }
  function save(q) {
    try { store.setItem(LS_QUEUE, JSON.stringify(q.slice(-QUEUE_CAP))); } catch {}
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, retryMs);
  }

  async function flush() {
    if (flushing) return; // one drain at a time; enqueue during drain is picked up below
    flushing = true;
    try {
      for (;;) {
        const q = load();
        if (!q.length) return;
        let r;
        try {
          r = await doFetch("/outfit-event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(q[0]),
          });
        } catch { schedule(); return; } // unreachable: keep the queue, retry later
        if (!r.ok && r.status !== 400) { schedule(); return; } // server error: retry
        // 204 sent, or 400 = malformed/stale event — drop it, never wedge the queue
        save(load().slice(1));
      }
    } finally { flushing = false; }
  }

  function send(kind, combo) {
    if (!Array.isArray(combo) || !combo.length) return;
    save(load().concat([{ kind, combo, ts: Date.now() }]));
    flush();
  }

  return { send, flush };
}
