// board.js — boot. Fetch /settings (dwell) + today's recipe -> model -> render.
// Activation flow lives in board-render (barge-in: Speech.stop() before acting);
// dwell.js drives gaze holds via class="dwell", a touch tap fires click() — one
// click handler covers both input paths.
import { createSession } from "./board-model.js";
import { mountBoard, mountDoorBar } from "./board-render.js";
import { createMusicPlayer } from "./music-player.js";

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
// ?recipe=<name> selects the board family (default the outfit board; the Songs
// Board kiosk opens /board/?recipe=songs). The last-good stash is keyed per
// recipe so songs and outfits never poison each other's cache; `today` keeps
// the legacy unsuffixed keys so existing devices don't drop their stash.
const RECIPE_NAME = (() => {
  try {
    const n = new URLSearchParams(location.search).get("recipe") || "today";
    return /^[a-z0-9-]{1,32}$/.test(n) ? n : "today";
  } catch { return "today"; }
})();
const RECIPE_URL = "/recipes/" + RECIPE_NAME + ".json";
const KEY_SUFFIX = RECIPE_NAME === "today" ? "" : ":" + RECIPE_NAME;
const LS_RECIPE = "board:lastRecipe" + KEY_SUFFIX;
const LS_ETAG = "board:lastRecipeEtag" + KEY_SUFFIX;
const T = Object.assign(
  { pollMs: 5 * 60 * 1000, retryMs: 15 * 1000, idleMs: 60 * 1000, statusMs: 15 * 1000, busyMs: 3000 },
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
let recipeMiss = "";   // "no-content" = server answered 404; "net" = unreachable
async function loadRecipe() {
  try {
    const res = await fetch(RECIPE_URL, { cache: "no-store" });
    recipeMiss = res.status === 404 ? "no-content" : "net";
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

// ---- book jobs (T2.11) -----------------------------------------------------
// A book is built out of photos a grown-up dropped in Drive: minutes of reading
// words off pages and recording narration, during which the board looks exactly
// the same as it did before. /content/status makes the same deal
// /clothing/status does, so the board says the same kind of thing about it —
// on the splash while there is nothing else to show, and in the footer strip
// once the board is up. Touch only, never a gaze target: this is grown-up news
// (design rule — the message bar carries the door and nothing else).
const REVIEW_URL = "/book-review/?slug=";

// One /content/status payload -> the one sentence the board should be showing,
// or null for "nothing worth saying". Shared by the splash and the footer so a
// book reads the same wherever it is seen. `watched` is the slug the caller has
// seen building, so a book that landed before the board opened is old news and
// stays quiet.
function bookNews(c, watched) {
  // mode !== local: books are built on the computer that holds the Drive
  // folder, and this one does not — Settings explains that, the board doesn't.
  if (!c || !c.local) return null;
  const jobs = c.jobs || [];
  const find = (slug) => jobs.filter((j) => j && j.slug === slug)[0] || null;
  if (c.building && c.job && c.job.kind === "books") {
    const j = find(c.job.slug) || {};
    const title = j.title || "a new book";
    const p = j.progress || {};
    // Count the page being worked on, not the ones finished: "page 5 of 12"
    // is what a parent watching over a shoulder sees on the table.
    const at = (done) => " — page " + Math.min((done || 0) + 1, p.pages) + " of " + p.pages;
    const step = c.job.step || j.step;
    let what = "Making " + title;
    if (step === "transcribe" && p.pages) what = "Reading the words of " + title + at(p.transcribed);
    else if (step === "narrate" && p.pages) what = "Recording " + title + at(p.narrated);
    return { busy: true, head: "Making a new book…",
             text: "📖 " + what + ". It appears in Book Reader by itself." };
  }
  const j = watched ? find(watched) : null;
  if (!j || !(j.published || j.state === "done")) return null;
  const title = j.title || "Your new book";
  // Flagged words publish anyway (ruling 9/4) — the book is readable now, and
  // the review page is where a grown-up fixes what the AI was unsure of.
  if (j.flags) return {
    busy: false,
    text: "✨ " + title + " is ready to read — " + j.flags + " word" +
          (j.flags === 1 ? "" : "s") + " the AI was unsure of.",
    href: REVIEW_URL + encodeURIComponent(j.slug), tap: "Check them →" };
  return { busy: false, text: "✨ " + title + " is ready to read in Book Reader." };
}

// Calm full-screen splash for the nothing-to-show case (first boot + server
// down). Static text, no targets — dwell has nothing to catch on.
// For the CLOTHING board the no-content state is a live coach (dad 8/31: a
// novice who just uploaded photos saw either nothing or raw photo dumps —
// the splash must say what worked and what the ONE next step is). The hub's
// /clothing/status tells us which state the family is in.
function showSplash(app) {
  app.innerHTML = "";
  // The same door strip the board itself wears: a splash that can last minutes
  // (naming 40 photos) is still a screen she must be able to leave (dad 9/3).
  const { sizeBar } = mountDoorBar(app, () => speech.stop && speech.stop());
  window.addEventListener("resize", sizeBar);
  const d = document.createElement("div");
  d.className = "splash";
  d.textContent = "Your board is waking up…";
  app.appendChild(d);
  if (recipeMiss !== "no-content") return;
  const h = document.createElement("a");
  h.className = "splash-note";
  // 0.55em of the giant splash headline rendered as fine print a parent could
  // not read across the room (QA 9/1). Fixed, generous px instead.
  h.style.cssText = "font-size:34px;line-height:1.35;display:block;max-width:22em;margin:28px auto 0;text-decoration:underline;cursor:pointer";
  h.href = "/settings/#integrations";
  h.textContent = "No content yet. Grown-ups: connect Google Drive in Settings to add photos, choices, and songs - tap here.";
  app.appendChild(h);
  if (RECIPE_NAME !== "today") return;   // coaching below is clothing-only

  // `said` = a clothing state claimed the splash. The clothing coach keeps
  // every word it had; a book only gets the line in the one case where the
  // coach has nothing of its own to say (T2.11).
  let said = false;
  const paint = (s) => {
    if (!s) return;
    said = true;
    if (s.ingesting && s.ingesting.total) {
      d.textContent = "Building the clothing picker…";
      h.removeAttribute("href");
      h.style.textDecoration = "none"; h.style.cursor = "default";
      h.textContent = "Naming photo " + Math.min(s.ingesting.done + 1, s.ingesting.total) +
        " of " + s.ingesting.total + " — the board opens by itself when it's ready.";
    } else if (s.building) {
      d.textContent = "Building the clothing picker…";
      h.removeAttribute("href");
      h.style.textDecoration = "none"; h.style.cursor = "default";
      h.textContent = "Putting outfits together — almost there.";
    } else if (s.photos > 0 && !s.aiConfigured) {
      // No count: Drive materialises files gradually, so any number we print is
      // stale the moment a parent adds more (dad 9/1: "it said 4, I uploaded
      // lots more — just say you see photos").
      d.textContent = "We can see your clothing photos — great work! 🎉";
      h.href = "/settings/#ai";
      h.style.textDecoration = "underline"; h.style.cursor = "pointer";
      h.textContent = "One more step: tap here to add an AI helper key in Settings, and New ERA will name each item and build daily outfits.";
    } else if (s.guidance === "ai-quota") {
      // 429/RESOURCE_EXHAUSTED: the free tier's daily allowance is spent. It
      // comes back tomorrow, so say that rather than implying a fault (9/1).
      d.textContent = "Today's free AI allowance is used up";
      h.removeAttribute("href");
      h.style.textDecoration = "none"; h.style.cursor = "default";
      h.textContent = "Your photos are safe. Google's free daily limit resets overnight — New ERA picks up where it left off and the outfits appear in the morning.";
    } else if (s.guidance === "ai-busy") {
      // the AI provider throttled every photo (Google's free tier answers 503
      // "high demand" in bursts). The hub retries by itself; say so plainly
      // instead of leaving a family staring at an empty board (9/1).
      d.textContent = "The AI helper is busy right now";
      h.removeAttribute("href");
      h.style.textDecoration = "none"; h.style.cursor = "default";
      h.textContent = "Your photos are safe — New ERA keeps trying and the outfits appear by themselves, usually within an hour.";
    } else if (s.aiConfigured && !s.photos && !s.cataloged) {
      d.textContent = "Your AI helper is ready ✓";
      h.href = "/settings/#integrations";
      h.style.textDecoration = "underline"; h.style.cursor = "pointer";
      h.textContent = "Now add photos of clothes to the clothing folder in Google Drive — tap here for the guide. Outfits build themselves after that.";
    } else {
      // neither photos nor key: the default Drive message above already fits
      said = false;
    }
  };
  // A book being built is the same news as an outfit being built: the board is
  // empty because the hub is busy making the first thing that goes in it. It
  // only speaks where the clothing coach falls through to the generic "connect
  // Drive" line — which is wrong anyway once /content/status says Drive is
  // connected and a book is under way.
  const paintBook = (c) => {
    const news = bookNews(c, null);
    if (said || !news || !news.busy) return;
    d.textContent = news.head;
    h.removeAttribute("href");
    h.style.textDecoration = "none"; h.style.cursor = "default";
    h.textContent = news.text;
  };
  const poll = async () => {
    const get = async (u) => {
      try { return await (await fetch(u, { cache: "no-store" })).json(); }
      catch { return null; }   // hub briefly away: keep the current text
    };
    const [s, c] = await Promise.all([get("/clothing/status"), get("/content/status")]);
    paint(s);
    paintBook(c);
  };
  poll();
  const t = setInterval(() => {
    if (!document.body.contains(d)) { clearInterval(t); return; }   // board mounted
    poll();
  }, 3000);
}

// Watch the server: banner while unreachable, reload when the recipe changed —
// but only once she has been idle long enough. While offline or holding a
// pending change we poll fast; healthy steady-state polls slow.
function startWatcher(state) {
  const net = document.getElementById("netWarn");
  const setNet = (on) => { if (net) net.classList.toggle("show", on); };
  setNet(state.offline);
  let pending = false; // a newer recipe exists, waiting for idle
  let timer = null;

  async function tick() {
    clearTimeout(timer);
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
    timer = setTimeout(tick, state.offline || pending ? T.retryMs : T.pollMs);
    return pending;
  }
  timer = setTimeout(tick, state.offline ? T.retryMs : T.pollMs);
  return { checkNow: tick };
}

// Wardrobe footer (clothing board only). Dad 9/3: "I added some photos
// after my first run - maybe a footer pops up notifying new photos found and
// are processing, and if not automatically triggered I can re-run today's
// outfits with the new ones." The hub notices new photos by itself (Drive
// sync -> rebuild); this makes that visible while the board is open. The
// grown-up's "do it NOW" lives in Settings (Sync now / Rebuild today's
// outfits) - the board's bar carries the door and nothing else (design rule,
// gate: board-input + board-pixel).
function startWardrobeWatch(watcher) {
  if (RECIPE_NAME !== "today") return;
  const note = document.getElementById("wardrobeNote");
  if (!note) return;
  const show = (text, ready) => {
    note.textContent = text; note.classList.add("show"); note.classList.toggle("ready", !!ready);
  };
  const hide = () => { note.classList.remove("show", "ready"); };
  note.addEventListener("click", () => { if (note.classList.contains("ready")) location.reload(); });

  let wasBusy = false, readyShown = false;
  async function poll() {
    let s = null;
    try { s = await (await fetch("/clothing/status", { cache: "no-store" })).json(); } catch { /* keep the current text */ }
    if (s) {
      const busy = !!(s.building || (s.ingesting && s.ingesting.total));
      if (s.ingesting && s.ingesting.total) {
        show("\uD83D\uDC55 New clothing photos found \u2014 adding photo " +
             Math.min(s.ingesting.done + 1, s.ingesting.total) + " of " + s.ingesting.total +
             ". New outfits come by themselves.");
      } else if (s.building) {
        show("\uD83D\uDC55 Putting today\u2019s outfits together\u2026");
      }
      if (wasBusy && !busy) {
        // a build just finished: is the board on screen the new one?
        const changed = await watcher.checkNow();
        if (changed) { show("\u2728 New outfits are ready \u2014 tap here to see them", true); readyShown = true; }
        else hide();
      } else if (!busy && !readyShown) hide();
      wasBusy = busy;
    }
    setTimeout(poll, wasBusy ? T.busyMs : T.statusMs);
  }
  poll();
}

// Book footer (every board — a book landing is family news wherever she is
// sitting, unlike the wardrobe note which is about the board it sits on).
// Shows the work while it happens and, once the book lands with words the AI
// was unsure of, the one tap to the review page. The grown-up's "do it NOW"
// stays in Settings; the bar carries the door and nothing else.
function startContentWatch() {
  const note = document.getElementById("contentNote");
  if (!note) return;
  const hide = () => { note.classList.remove("show", "ready"); note.textContent = ""; };
  // textContent, never innerHTML: the book's title is family text and the only
  // untrusted string on this strip.
  const paint = (news) => {
    note.textContent = news.text;
    note.classList.toggle("ready", !!news.href);
    if (news.href) {
      const a = document.createElement("a");
      a.href = news.href;
      a.textContent = news.tap;
      note.appendChild(document.createTextNode(" "));
      note.appendChild(a);
    }
    note.classList.add("show");
  };

  let watched = null;   // the book we have seen building
  let settled = false;  // its "ready" line is up: leave it there to be read
  async function poll() {
    let c = null;
    try { c = await (await fetch("/content/status", { cache: "no-store" })).json(); }
    catch { /* hub briefly away: keep the current text */ }
    let busy = false;
    if (c) {
      busy = !!(c.building && c.job && c.job.kind === "books");
      if (busy) { watched = c.job.slug; settled = false; }
      const news = bookNews(c, watched);
      if (news && (busy || !settled)) { paint(news); settled = !busy; }
      else if (!news && !settled) hide();
    }
    setTimeout(poll, busy ? T.busyMs : T.statusMs);
  }
  poll();
}

async function boot() {
  // dwell time first (best-effort; default 1200 if /settings is unreachable).
  let dwellMs = 1200;
  let musicVolCap;   // % loudness cap for the Songs Board (undefined = offline; player uses its cached value)
  try {
    const st = await (await fetch("/settings", { cache: "no-store" })).json();
    if (st.childName) window.ERA_CHILD_NAME = st.childName;
    if (typeof st.musicVolCap === "number") musicVolCap = st.musicVolCap;
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
  // Songs Board (spec 8/24): the player exists only when the recipe carries
  // song tiles — the outfit board never pays for it.
  const allButtons = (r.json.boards || []).flatMap((b) => b.buttons || []);
  const music = allButtons.some((b) => b && b.type === "song")
    ? createMusicPlayer({ volCap: musicVolCap }) : null;
  const api = mountBoard({ mount: app, session, speech, dwellMs, music });

  // what-next deep link (movies spec §5): ?board=<id> opens the session on that
  // board — how ERAgaze reveals the picker on a show's "what next?" page after
  // an episode ends (?recipe=movies&board=<show>-next). Same sanitizing shape
  // as ?recipe=; an unknown id is a safe no-op (session.navigate warns, stays).
  try {
    const b = new URLSearchParams(location.search).get("board");
    if (b && /^[a-z0-9-]{1,64}$/.test(b)) api.show(b);
  } catch { /* malformed URL: root board stands */ }

  // window hook: renderer API for kiosk control + pixel-audit state injection.
  window.Board = api;
  if (music) {
    window.Music = music; // test hook + partner console access
    music.prefetch(allButtons); // background: after this, songs survive offline
  }
  window.dispatchEvent(new CustomEvent("board:ready"));
  const watcher = startWatcher({ etag: r.etag, offline: r.offline });
  startWardrobeWatch(watcher);
  startContentWatch();
}

boot().catch((err) => {
  console.error("[board] boot failed", err);
  const app = document.getElementById("app");
  if (app) app.textContent = "Board failed to load.";
});
