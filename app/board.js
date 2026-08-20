// board.js — boot. Fetch /settings (dwell) + today's recipe -> model -> render.
// Activation flow lives in board-render (barge-in: Speech.stop() before acting);
// dwell.js drives gaze holds via class="dwell", a touch tap fires click() — one
// click handler covers both input paths.
import { createSession } from "./board-model.js";
import { mountBoard } from "./board-render.js";

const baseSpeech = window.Speech || {
  say() {}, stop() {}, init() { return Promise.resolve(); },
};

// --- test hook (inert in production): a test opts in by setting window.__testHooks
// BEFORE this module runs (playwright addInitScript). It wraps Speech so say/stop
// calls are logged to window.__speechLog in order — lets input tests assert
// barge-in ordering + silent navs without real audio. Never active otherwise. ---
function installSpeechSpy(s) {
  window.__speechLog = window.__speechLog || [];
  return {
    say(text, kind) { window.__speechLog.push({ call: "say", text }); return s.say ? s.say(text, kind) : undefined; },
    stop() { window.__speechLog.push({ call: "stop" }); return s.stop ? s.stop() : undefined; },
    init(sample) { return s.init ? s.init(sample) : Promise.resolve(); },
    preload(t) { return s.preload ? s.preload(t) : undefined; },
    mode: s.mode ? s.mode.bind(s) : (() => undefined),
  };
}
const speech = window.__testHooks ? installSpeechSpy(baseSpeech) : baseSpeech;

// clamp /settings dwell into the sane band (matches server POST clamp).
function clampDwell(n) {
  if (typeof n !== "number" || !isFinite(n)) return 1200;
  return Math.max(600, Math.min(3000, n));
}

// ---- freshness + resilience (T3.2 / T3.3-B) --------------------------------
// No service worker (D40: plain-HTTP server, no secure context). Instead: last-good recipe
// in localStorage, an auto-retry splash when there is nothing to show, and an
// ETag HEAD poll that reloads ONLY while she is idle — never yank the board
// mid-use. Timing keys overridable by tests via window.__boardTest.
const RECIPE_URL = "/recipes/today.json";
const LS_RECIPE = "board:lastRecipe";
const LS_ETAG = "board:lastRecipeEtag";
const T = Object.assign(
  { pollMs: 5 * 60 * 1000, retryMs: 15 * 1000, idleMs: 60 * 1000 },
  window.__boardTest || {},
);

// idle = time since the last pointer/gaze/dwell event. ERAgaze moves the real
// cursor, so pointermove covers gaze hovers too.
let lastActivity = Date.now();
const bump = () => { lastActivity = Date.now(); };
["pointermove", "pointerdown", "keydown"].forEach((ev) =>
  document.addEventListener(ev, bump, { passive: true, capture: true }));
document.addEventListener("dwell:activate", bump, true);
const idleFor = () => Date.now() - lastActivity;

// Fetch the recipe; on success also stash it as the last-good copy. On any
// failure fall back to the stash. Returns {json, etag, offline} or null when
// there is neither network nor cache.
async function loadRecipe() {
  try {
    const res = await fetch(RECIPE_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("recipe " + res.status);
    const text = await res.text();
    const json = JSON.parse(text); // parse BEFORE caching — never stash garbage
    const etag = res.headers.get("etag") || "";
    try {
      localStorage.setItem(LS_RECIPE, text);
      localStorage.setItem(LS_ETAG, etag);
    } catch { /* storage full/blocked: cache is best-effort */ }
    return { json, etag, offline: false };
  } catch {
    try {
      const text = localStorage.getItem(LS_RECIPE);
      if (text) {
        return { json: JSON.parse(text), etag: localStorage.getItem(LS_ETAG) || "", offline: true };
      }
    } catch { /* corrupt stash: treat as empty */ }
    return null;
  }
}

// Calm full-screen splash for the nothing-to-show case (first boot + server
// down). Static text, no targets — dwell has nothing to catch on.
function showSplash(app) {
  app.innerHTML = "";
  const d = document.createElement("div");
  d.className = "splash";
  d.textContent = "Your board is waking up…";
  app.appendChild(d);
}

// Watch the server: banner while unreachable, reload when the recipe changed —
// but only once she has been idle long enough. While offline or holding a
// pending change we poll fast; healthy steady-state polls slow.
function startWatcher(state) {
  const net = document.getElementById("netWarn");
  const setNet = (on) => { if (net) net.classList.toggle("show", on); };
  setNet(state.offline);
  let pending = false; // a newer recipe exists, waiting for idle

  async function tick() {
    try {
      const res = await fetch(RECIPE_URL, { method: "HEAD", cache: "no-store" });
      if (!res.ok) throw new Error("head " + res.status);
      if (state.offline) { state.offline = false; setNet(false); }
      const etag = res.headers.get("etag") || "";
      if (etag && etag !== state.etag) pending = true;
      if (pending && idleFor() >= T.idleMs) { location.reload(); return; }
    } catch {
      if (!state.offline) { state.offline = true; setNet(true); }
    }
    setTimeout(tick, state.offline || pending ? T.retryMs : T.pollMs);
  }
  setTimeout(tick, state.offline ? T.retryMs : T.pollMs);
}

async function boot() {
  // dwell time first (best-effort; default 1200 if /settings is unreachable).
  let dwellMs = 1200;
  try {
    const st = await (await fetch("/settings", { cache: "no-store" })).json();
    if (st.childName) window.ERA_CHILD_NAME = st.childName;
    dwellMs = clampDwell(st.dwellMs);
    if (window.Dwell) Dwell.setMs(dwellMs); // keep the engine default in sync
    // page-settle (27P #5b): runtime-tunable like the hold; clamp matches server.
    if (window.Dwell && typeof st.settleMs === "number" && isFinite(st.settleMs))
      Dwell.set({ settleMs: Math.max(0, Math.min(2000, st.settleMs)) });
  } catch { /* offline: default band */ }

  // her voice (ElevenLabs if keyed, else local). Boot self-test -> partner banner
  // (pencil pattern): if TTS falls back to nothing, warn the partner (touch only).
  try {
    const mode = await speech.init("Board ready.");
    if (mode === "off") {
      const warn = document.getElementById("ttsWarn");
      if (warn) warn.classList.add("show");
    }
  } catch { /* never block the board on audio */ }

  const app = document.getElementById("app");
  let r = await loadRecipe();
  if (!r) {
    // nothing to show yet: splash + auto-retry until the server answers.
    showSplash(app);
    r = await new Promise((resolve) => {
      const t = setInterval(async () => {
        const rr = await loadRecipe();
        if (rr) { clearInterval(t); resolve(rr); }
      }, T.retryMs);
    });
  }
  const session = createSession(r.json);
  app.innerHTML = ""; // clear splash if it was up
  const api = mountBoard({ mount: app, session, speech, dwellMs });

  // window hook: renderer API for kiosk control + pixel-audit state injection.
  window.Board = api;
  window.dispatchEvent(new CustomEvent("board:ready"));
  startWatcher({ etag: r.etag, offline: r.offline });
}

boot().catch((err) => {
  console.error("[board] boot failed", err);
  const app = document.getElementById("app");
  if (app) app.textContent = "Board failed to load.";
});
