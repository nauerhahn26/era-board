// board-render.js — DOM renderer + message bar (T1.2 + T1.3, post Gate-1 review).
// Fixed chrome: a top message-bar strip of RESERVED height (zero layout shift
// whether empty or full) and a board area below. The grid FILLS the remaining
// screen with wide rectangular tiles (TD Snap style): rows x cols stretch to the
// full area, 28px gap, side padding <= 48. Every empty cell is a black inert
// rest box; declared rows always render (never-empty bottom row).
//
// WORD INTEGRITY (Gate-1 core constraint — she is learning to read):
// labels NEVER break mid-word, NEVER hyphenate, NEVER clip. Wrapping happens at
// word boundaries only. Fit order per label: >=74px in the normal label area ->
// grow the label area -> (beside tiles) switch to stacked full-width -> only
// then reduce that one label's font, floor 44px (~32pt vision spec), marked
// data-font-reduced for the pixel gate.

import { CONTRACT as EC } from "../lib/contract.js";
import { createOutfitEvents } from "./board-events.js";

// ---- one place for every tunable — VALUES COME FROM lib/contract.js (the
// whitelist; mirrors knowledge/ux-contract.md). CONFIG keeps the renderer's
// historical names so call sites read naturally; it holds no numbers of its own.
export const CONFIG = {
  BAR_H: EC.sizes.barH,          // reserved message-bar height, always
  SIDE_PAD: EC.sizes.sidePadBoard, // <= 48 per Gate-1 review (>= 40 per original spec)
  V_PAD: EC.sizes.vPad,
  GAP: EC.sizes.gapFloor,        // fixed grid gap (the mishit-resistance floor)
  FONT_FLOOR: EC.sizes.fontFloor, // target floor; only a fit-impossible label goes below
  FONT_MIN: EC.sizes.fontMin,    // absolute minimum (~32pt) — never smaller, never clipped
  FONT_CAP: EC.sizes.fontCap,
  // photo tiles (her real clothes): the PHOTO is the message (dad 7/24) — it
  // keeps ~4/5 of the tile; the label rides small on a fixed plate below.
  // Deliberately below the 74px floor, which applies to TEXT tiles only.
  PHOTO_LABEL_SHARE: EC.sizes.photoLabelShare,
  PHOTO_PLATE_MIN: EC.sizes.photoPlateMin, // px — small viewports still get a legible strip
  PHOTO_FONT_CAP: EC.sizes.photoFontCap,
  PHOTO_FONT_MIN: EC.sizes.photoFontMin,
  BESIDE_MAX_CHARS: 14,
  BESIDE_MIN_W: 520, // beside layout only on tiles wide enough for a 74px label
  // Dwell holds (ms) — T2.1. Content tiles (speak/append leaves) use the runtime
  // /settings dwellMs; nav DOORS get a deliberate max(dwellMs+400, 1600). Bar
  // Speak/Clear are fixed long holds. A tile is a "door" when it navigates
  // (btn.load) or is a structural nav type (category/back/more).
  DWELL_DEFAULT: EC.holds.content, // fallback when /settings is unreachable
  DWELL_NAV_MIN: EC.holds.navMin,  // floor for nav-door holds
  DWELL_NAV_BONUS: EC.holds.navBonus, // added to content dwell for doors, before the floor
  DWELL_SPEAK: EC.holds.answer,
  DWELL_CLEAR: EC.holds.clear,
  DWELL_EXIT: EC.holds.exit,       // the round-trip door back to TD Snap
  // type -> tile background. rest black; yes green; outfit/clothing white;
  // control teal; category/back/more grey. (board-design-rules.md)
  // colors mirror lib/tokens.css primitives (CSS custom props can't cross into
  // this canvas-side map; tokens.css remains the palette of record)
  color: { rest: "#000000", yes: "#2E9E4B", outfit: "#FFFFFF", clothing: "#FFFFFF",
           control: "#0F7C8A", category: "#6B7B82", back: "#6B7B82", more: "#6B7B82",
           exit: "#6B7B82",
           word: "#FFFFFF",
           song: "#FFFFFF", stop: "#0F7C8A",     // Songs Board (spec 8/24)
           show: "#FFFFFF", movie: "#FFFFFF", episode: "#FFFFFF" }, // Movies (spec 8/29)
  INK_DARK: "#17272E",
  INK_LIGHT: "#FFFFFF",
};

// tiles whose ink should be dark (light backgrounds)
const LIGHT_BG = new Set(["outfit", "clothing", "word", "song",
                          "show", "movie", "episode"]);

// structural nav types (doors even if a recipe omits an explicit load).
// `show` is the movies board's door tile: it navigates to its show board
// (btn.board) with full door semantics — silent, deliberate nav hold.
const NAV_TYPES = new Set(["category", "back", "more", "show"]);
// movie/episode tiles LAUNCH the streaming app via ERAgaze — the board never
// plays video (movies spec §5). Leaving the board for another app is at least
// as big a commitment as a nav door, so they ride the nav-tier hold (existing
// rung, no new number invented — whitelist principle, ux-contract).
const LAUNCH_TYPES = new Set(["movie", "episode"]);
// the EXIT tile leaves the app entirely (ERAgaze hands the screen to TD Snap) —
// fixed longest hold, silent like every nav door (phase 4.1).
const EXIT_TYPE = "exit";

// Round-trip exit (phase 4.1): ERAgaze closes this kiosk and foregrounds TD Snap;
// dev browsers fall back to a reload. Fired by the msgbar door (dad 8/5, D47) and
// by any grid `type:"exit"` tile a recipe seats. Silent, like all nav doors.
// The kiosk origin ($ServerUrl/board/) is pre-allowed for 127.0.0.1 calls by the
// installer's Chrome LNA policies (windows-device.ps1 step 2b) — no Allow prompt.
function exitToTDSnap() {
  fetch("http://127.0.0.1:49155/app/exit", { method: "POST" })
    .then((r) => { if (!r.ok) location.reload(); })
    .catch(() => location.reload());
}

// A "door" navigates the board (btn.load) or is a structural nav type. Doors get
// the deliberate hold; everything else (outfit/clothing/yes/word/control-speak
// leaves) is a content tile on the runtime dwellMs.
function isDoor(btn, type) {
  return btn.load != null || NAV_TYPES.has(type) || LAUNCH_TYPES.has(type);
}
// dwellMs = runtime content hold (from /settings). Returns this tile's hold ms.
function tileDwellMs(btn, type, dwellMs) {
  if (type === EXIT_TYPE) return CONFIG.DWELL_EXIT;
  if (!isDoor(btn, type)) return dwellMs;
  return Math.max(dwellMs + CONFIG.DWELL_NAV_BONUS, CONFIG.DWELL_NAV_MIN);
}

// ---- sizing math (pure) ----------------------------------------------------

// Fill-the-area grid: tiles are free-floating rectangles; rows x cols stretch to
// the available box with a fixed 28px gap. (Gate-1: "use the screen".)
export function gridFit(rows, cols, availW, availH) {
  const gap = CONFIG.GAP;
  const w = Math.max(60, Math.floor((availW - (cols - 1) * gap) / cols));
  const h = Math.max(60, Math.floor((availH - (rows - 1) * gap) / rows));
  return { w, h, gap };
}

// ---- asset paths -----------------------------------------------------------

// recipe image paths: 'wardrobe/...' -> /wardrobe/... (real photos, cover-fill);
// 'packages/generator/assets/x.png' -> /gen-assets/x.png (icons, contained).
function imageSrc(path) {
  if (!path) return null;
  if (path.startsWith("packages/generator/assets/")) {
    return "/gen-assets/" + path.split("/").pop();
  }
  if (path.startsWith("/")) return path;
  return "/" + path; // wardrobe/... and any other relative recipe path
}
function symbolSrc(name) { return "/symbol/" + encodeURIComponent(name); }

// A "photo" fills its cell (her real clothes; a song's cover art; a movie or
// show poster); an "icon" (symbol or gen-asset PNG) is contained with a label
// beside/under it. A movie/episode tile with image:null falls through to the
// icon path with no image = a text tile at contract font sizes.
function isPhoto(btn) {
  return typeof btn.image === "string" &&
         (btn.image.startsWith("wardrobe/") || btn.image.startsWith("music/") ||
          btn.image.startsWith("movies/"));
}

// ---- label fitting (word integrity) ----------------------------------------

// Largest font so the label fits its box with word-boundary wrapping only:
// no horizontal overflow (a whole word never exceeds the line) and total height
// within maxH. Tries each maxH tier (growing the label area) at >=74 first;
// only when no tier fits does it dip below 74 (floor 44) on the LAST tier.
function fitFont(labelEl, tiers, startPx) {
  const down = [];
  for (let f = Math.max(CONFIG.FONT_FLOOR, Math.min(CONFIG.FONT_CAP, startPx));
       f >= CONFIG.FONT_FLOOR; f -= 6) down.push(f);
  if (down[down.length - 1] !== CONFIG.FONT_FLOOR) down.push(CONFIG.FONT_FLOOR);
  const fits = (f, maxH) => {
    labelEl.style.fontSize = f + "px";
    return labelEl.scrollWidth <= labelEl.clientWidth + 1 && labelEl.scrollHeight <= maxH;
  };
  for (const maxH of tiers) {
    for (const f of down) if (fits(f, maxH)) return { f, maxH };
  }
  const last = tiers[tiers.length - 1];
  for (let f = CONFIG.FONT_FLOOR - 4; f >= CONFIG.FONT_MIN; f -= 4) {
    if (fits(f, last)) return { f, maxH: last };
  }
  labelEl.style.fontSize = CONFIG.FONT_MIN + "px";
  return { f: CONFIG.FONT_MIN, maxH: last };
}

// Photo-plate fitting: fixed box, small fonts (cap 46 -> min 24). Word
// integrity still holds (no horizontal overflow, no clipping); the plate
// never grows — the photo owns the rest of the tile.
function applyPhotoFit(labelEl) {
  const fits = (f) => {
    labelEl.style.fontSize = f + "px";
    return labelEl.scrollWidth <= labelEl.clientWidth + 1 &&
           labelEl.scrollHeight <= labelEl.clientHeight + 2;
  };
  let f = CONFIG.PHOTO_FONT_CAP;
  for (; f > CONFIG.PHOTO_FONT_MIN; f -= 2) if (fits(f)) break;
  if (f <= CONFIG.PHOTO_FONT_MIN) { f = CONFIG.PHOTO_FONT_MIN; fits(f); }
  labelEl.dataset.fontPx = String(f);
  return f;
}

function applyFit(labelEl, tiers, startPx) {
  const { f } = fitFont(labelEl, tiers, startPx);
  labelEl.dataset.fontPx = String(f);
  if (f < CONFIG.FONT_FLOOR) labelEl.dataset.fontReduced = "1";
  else delete labelEl.dataset.fontReduced;
  return f;
}

// ---- tile / cell construction ---------------------------------------------

function restCell() {
  const d = document.createElement("div");
  d.className = "cell rest";
  d.setAttribute("aria-hidden", "true");
  return d;
}

// Returns { el, fit } — fit() must run AFTER the tile is in the document.
// dwellMs = runtime content hold (per-type door/leaf split applied here).
function makeTile(btn, w, h, dwellMs) {
  const el = document.createElement("button");
  const type = btn.type || "control";
  el.className = "cell tile dwell type-" + type;
  el.type = "button";
  el.dataset.dwellMs = String(tileDwellMs(btn, type, dwellMs));
  el.setAttribute("aria-label", btn.label || "");
  el.dataset.dwellSay = btn.say != null ? btn.say : (btn.label || "");

  const bg = CONFIG.color[type] || CONFIG.color.control;
  el.style.background = bg;
  el.style.color = LIGHT_BG.has(type) ? CONFIG.INK_DARK : CONFIG.INK_LIGHT;

  // Movies board episode marks (spec §2 generator): "next" = the highlighted
  // next-unwatched episode; "again" = the last-watched, offered as a rewatch.
  // Pure CSS classes, same approach as the songs .playing marker.
  if (btn.mark === "next") el.classList.add("mark-next");
  else if (btn.mark === "again") el.classList.add("mark-again");

  const src = btn.image ? imageSrc(btn.image) : (btn.symbol ? symbolSrc(btn.symbol) : null);
  // songs-board control tiles maximize their text (dad's round 3): start the
  // fitter at the cap and let it walk down, instead of the h*0.3 heuristic.
  const startPx = (type === "stop" || type === "full")
    ? CONFIG.FONT_CAP : Math.round(h * 0.3);

  if (isPhoto(btn)) {
    // photo-first (dad 7/24): the outfit photo IS the message — it keeps ~4/5
    // of the tile and never yields to the label. The plate is a FIXED small
    // strip; the font fits inside it (word integrity kept, small by design).
    // EXCEPT the song-page HERO (spanning tile, dad 8/24 r4): its plate is
    // huge, so the title fits at reading size (74 floor, up to the cap).
    const isHero = (btn.row_span | 0) > 1 || (btn.col_span | 0) > 1;
    if (isHero) el.classList.add("hero");
    el.classList.add("photo");
    const img = document.createElement("img");
    img.className = "photo-img";
    img.src = src; img.alt = "";
    const plate = document.createElement("span");
    plate.className = "tile-label plate";
    plate.textContent = btn.label || "";
    const plateH = Math.max(CONFIG.PHOTO_PLATE_MIN,
                            Math.round(h * CONFIG.PHOTO_LABEL_SHARE));
    plate.style.height = plateH + "px";
    el.appendChild(img);
    if (type === "song") {
      // full-mode acknowledgment (dad 8/24 round 3): a strip under the image
      // that lights up when the whole song is authorized. Hidden until .full-on.
      const badge = document.createElement("span");
      badge.className = "full-badge";
      badge.textContent = "Full song ✓";
      badge.setAttribute("aria-hidden", "true");
      el.appendChild(badge);
    }
    el.appendChild(plate);
    // NB: the plate's height is FIXED inline, so scrollHeight can never be
    // below plateH — the fit budget must be plateH itself, not less.
    const fit = isHero
      ? () => applyFit(plate, [plateH], CONFIG.FONT_CAP)  // title at reading size
      : () => applyPhotoFit(plate);
    return { el, fit };
  }

  // glyph tile (dad 8/24): a BIG glyph carries the message — the songs board's
  // back arrow (the ARASAAC "back" symbol is a person's back; weird) — with the
  // word underneath (dad's round 3), text maximized to the tile.
  if (btn.glyph) {
    el.classList.add("glyph");
    el.setAttribute("aria-label", btn.say || btn.label || "");
    const g = document.createElement("span");
    g.className = "tile-glyph";
    g.textContent = btn.glyph;
    g.setAttribute("aria-hidden", "true");
    el.appendChild(g);
    let lab = null;
    if (btn.label) {
      lab = document.createElement("span");
      lab.className = "tile-label";
      lab.textContent = btn.label;
      el.appendChild(lab);
    }
    const fit = () => {
      g.style.fontSize = Math.round(h * (lab ? 0.4 : 0.52)) + "px";
      if (lab) applyFit(lab, [h * 0.4], CONFIG.FONT_CAP);
    };
    return { el, fit };
  }

  // icon tile: contained image + label. Short labels sit BESIDE the image
  // (image left ~40%, label right) on roomy tiles; otherwise stacked. With no
  // image at all (e.g. a poster-less movie tile) "beside" would left-shove a
  // lone label — stacked centers it, pure text at contract sizes.
  const short = src != null &&
                (btn.label || "").length <= CONFIG.BESIDE_MAX_CHARS &&
                w >= CONFIG.BESIDE_MIN_W;
  el.classList.add("icon", short ? "beside" : "stacked");
  if (src) {
    const img = document.createElement("img");
    img.className = "tile-img contain";
    img.src = src; img.alt = "";
    el.appendChild(img);
  }
  const lab = document.createElement("span");
  lab.className = "tile-label";
  lab.textContent = btn.label || "";
  el.appendChild(lab);
  if (btn.footnote) {
    // dad-only freshness stamp (e.g. the weather tile's "updated ..."):
    // deliberately tiny, absolutely positioned, never spoken, invisible to
    // the label fitter and the pixel gate (.tile-foot, not .tile-label).
    const foot = document.createElement("span");
    foot.className = "tile-foot";
    foot.textContent = btn.footnote;
    foot.setAttribute("aria-hidden", "true");
    el.appendChild(foot);
  }

  const fit = () => {
    if (el.classList.contains("beside")) {
      const f = applyFit(lab, [h - 36], startPx);
      if (f >= CONFIG.FONT_FLOOR) return f;
      // can't hold 74 beside: switch to stacked full-width, then refit.
      el.classList.remove("beside");
      el.classList.add("stacked");
    }
    return applyFit(lab, [h * 0.55, h * 0.80], startPx);
  };
  return { el, fit };
}

// ---- board layout ----------------------------------------------------------

// Place buttons into a rows*cols grid. Honors explicit 1-indexed row/col pins;
// flows the rest into the first free cells; fills every remaining cell with a
// black rest box. Declared rows always render, so the bottom row is never empty.
// A pinned button may span cells (row_span/col_span >= 1, songs-board hero):
// the anchor index holds the button; every other covered cell holds TAKEN so
// flow and rest-fill skip it. Render places cells on the explicit grid.
const TAKEN = Symbol("span-covered");
function layoutCells(board) {
  const cols = Math.max(1, board.columns || 1);
  const declared = Math.max(1, board.rows || 1);
  const buttons = board.buttons || [];
  const rows = Math.max(declared, Math.ceil(buttons.length / cols));
  const total = rows * cols;
  const slots = new Array(total).fill(null);

  const flow = [];
  for (const b of buttons) {
    if (Number.isInteger(b.row) && Number.isInteger(b.col)) {
      const rs = Math.max(1, b.row_span | 0 || 1), cs = Math.max(1, b.col_span | 0 || 1);
      const idx = (b.row - 1) * cols + (b.col - 1);
      const fits = idx >= 0 && idx < total && b.row - 1 + rs <= rows && b.col - 1 + cs <= cols;
      if (fits) {
        let free = true;
        for (let r = 0; r < rs && free; r++)
          for (let c = 0; c < cs && free; c++)
            if (slots[idx + r * cols + c] != null) free = false;
        if (free) {
          slots[idx] = b;
          for (let r = 0; r < rs; r++)
            for (let c = 0; c < cs; c++)
              if (r || c) slots[idx + r * cols + c] = TAKEN;
          continue;
        }
      }
    }
    flow.push(b);
  }
  let f = 0;
  for (let i = 0; i < total && f < flow.length; i++) if (slots[i] == null) slots[i] = flow[f++];
  return { rows, cols, slots };
}

// ---- mount / render --------------------------------------------------------

export function mountBoard({ mount, session, speech, dwellMs, music }) {
  const sp = speech || { say() {}, stop() {} };
  // runtime content-tile hold from /settings (board.js clamps 600-3000).
  const contentDwellMs = (typeof dwellMs === "number" && isFinite(dwellMs))
    ? dwellMs : CONFIG.DWELL_DEFAULT;
  const chips = []; // {label, image, symbol}

  // chrome (built once — fixed heights => zero layout shift)
  mount.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "msgbar";
  bar.style.height = CONFIG.BAR_H + "px";
  // top-left door back to TD Snap (dad 8/5, D47): SMALL bar chrome, not a grid
  // seat — same learned position, hold (2400ms) and silent round trip as the
  // literacy apps' 🚪. Always armed (unlike Speak/Clear it needs no chips).
  const doorBtn = document.createElement("button");
  doorBtn.type = "button"; doorBtn.className = "bardoor dwell"; doorBtn.id = "barDoor";
  doorBtn.textContent = "🚪";
  doorBtn.dataset.dwellMs = String(CONFIG.DWELL_EXIT);
  doorBtn.dataset.dwellSay = "door";
  doorBtn.setAttribute("aria-label", "door");
  doorBtn.addEventListener("click", () => { sp.stop && sp.stop(); if (music) music.stop(); exitToTDSnap(); });
  const chipsEl = document.createElement("div");
  chipsEl.className = "chips";
  const ctl = document.createElement("div");
  ctl.className = "barctl";
  const speakBtn = document.createElement("button");
  speakBtn.type = "button"; speakBtn.className = "barbtn"; speakBtn.id = "barSpeak";
  speakBtn.textContent = "Speak"; speakBtn.setAttribute("aria-label", "Speak");
  const clearBtn = document.createElement("button");
  clearBtn.type = "button"; clearBtn.className = "barbtn"; clearBtn.id = "barClear";
  clearBtn.textContent = "Clear"; clearBtn.setAttribute("aria-label", "Clear");
  ctl.appendChild(speakBtn); ctl.appendChild(clearBtn);
  bar.appendChild(doorBtn); bar.appendChild(chipsEl); bar.appendChild(ctl);

  const area = document.createElement("div");
  area.className = "board-area";

  mount.appendChild(bar);
  mount.appendChild(area);

  // --- message bar behavior ---
  function syncControls() {
    const on = chips.length > 0;
    for (const [btn, ms] of [[speakBtn, CONFIG.DWELL_SPEAK], [clearBtn, CONFIG.DWELL_CLEAR]]) {
      if (on) {
        btn.classList.add("dwell");
        btn.dataset.dwellMs = String(ms);
        btn.removeAttribute("aria-disabled");
      } else {
        // unusable => zero gaze targets: NOT .dwell, aria-disabled
        btn.classList.remove("dwell");
        btn.removeAttribute("data-dwell-ms");
        btn.setAttribute("aria-disabled", "true");
      }
    }
  }
  function renderChip(chip) {
    const c = document.createElement("div");
    c.className = "chip";
    const src = chip.image ? imageSrc(chip.image) : (chip.symbol ? symbolSrc(chip.symbol) : null);
    if (src) { const img = document.createElement("img"); img.className = "chip-img"; img.src = src; img.alt = ""; c.appendChild(img); }
    const s = document.createElement("span"); s.className = "chip-label"; s.textContent = chip.label || "";
    c.appendChild(s);
    chipsEl.appendChild(c);
    // append right; if overflowing, scroll oldest off the left. Existing chips
    // keep their DOM position — only the viewport scrolls.
    chipsEl.scrollLeft = chipsEl.scrollWidth;
  }
  function appendChip(chip) { chips.push(chip); renderChip(chip); syncControls(); }
  function clearBar() {
    chips.length = 0; chipsEl.innerHTML = ""; syncControls();
    sp.stop && sp.stop(); sp.say && sp.say("cleared");
  }
  function speakBar() {
    if (!chips.length) return;
    sp.stop && sp.stop();
    sp.say && sp.say(chips.map((c) => c.label).join(" "));
  }
  speakBtn.addEventListener("click", () => { if (speakBtn.classList.contains("dwell")) speakBar(); });
  clearBtn.addEventListener("click", () => { if (clearBtn.classList.contains("dwell")) clearBar(); });

  // outfit pick telemetry (Phase 2, D49): recipe buttons carrying `combo` report
  // select (outfit tile) / yes (confirm) — fire-and-forget, offline-queued.
  const outfitEvents = createOutfitEvents();
  outfitEvents.flush(); // drain anything queued while the server was away

  // --- playing-song marker (Songs Board): the active song's tile carries
  // .playing so she can see what is on. Survives page nav via re-apply in render.
  let songEls = new Map(); // song_id -> tile element (rebuilt every render)

  // --- currently-watching marker (Movies Board, spec 8/29): after a SUCCESSFUL
  // /app/launch the launched tile wears .watching — the applyPlaying pattern:
  // the key survives page nav in mount state, tiles are re-marked every render,
  // and the next successful launch moves the marker. Nothing persists to disk;
  // a board reload starts unmarked (ERAgaze owns the real watch session).
  let movieEls = new Map();   // launch-key -> tile element (rebuilt every render)
  let watchingKey = null;
  const launchKey = (btn) =>
    String(btn.titleId) +
    (btn.episode ? ":s" + btn.episode.s + "e" + btn.episode.e : "");
  function applyWatching() {
    for (const [k, el] of movieEls) el.classList.toggle("watching", k === watchingKey);
  }

  // movie usage telemetry -> the family pool (clone of the music-event call:
  // fire-and-forget, never blocks, never queues — nice-to-have, not precious).
  function postMovieEvent(btn) {
    const body = { titleId: btn.titleId, service: btn.service, action: "launch" };
    if (btn.episode) body.episode = btn.episode;
    try {
      fetch("/movie-event", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch { /* telemetry is nice-to-have, never load-bearing */ }
  }

  // The launch: the board NEVER plays video — it hands the deep link to ERAgaze
  // (POST /app/launch on the gaze bus port), which spawns the streaming kiosk
  // and enters watch mode. No explicit Content-Type header, same as /app/exit:
  // a simple request needs no CORS preflight against the native listener; the
  // body is exactly the contract JSON. On failure (ERAgaze away/refusing) the
  // board must stay usable for a caregiver rescue: brief calm visual flag on
  // the tile, no crash, no reload, no marker, no event.
  // D57c: the watch overlay's small "next episode" rail button needs the next
  // episode's URL up front — derive it from the loaded recipe (episode cells of
  // the same title across its show boards, season/episode order). One hop only;
  // the full advance-loop is the what-next flow.
  function nextEpisodeOf(btn) {
    if (!btn.episode || !EC.session) return null;
    const eps = [];
    const boards = EC.session.model ? Array.from(EC.session.model.boards.values()) : [];
    for (const b of boards)
      for (const c of (b.buttons || []))
        if (c.type === "episode" && c.titleId === btn.titleId && c.url) eps.push(c);
    eps.sort((a, b) => (a.episode.s - b.episode.s) || (a.episode.e - b.episode.e));
    const i = eps.findIndex((c) => c.episode.s === btn.episode.s && c.episode.e === btn.episode.e);
    if (i < 0 || i + 1 >= eps.length) return null;
    const n = eps[i + 1];
    return { url: n.url, episode: n.episode, label: n.label };
  }

  function launchMovie(btn, el) {
    const body = { url: btn.url, watch: true, titleId: btn.titleId };
    if (btn.episode) body.episode = btn.episode;
    const nx = nextEpisodeOf(btn);
    if (nx) body.next = nx;
    fetch("http://127.0.0.1:49155/app/launch", {
      method: "POST", body: JSON.stringify(body),
    }).then((r) => {
      if (!r.ok) throw new Error("launch " + r.status);
      watchingKey = launchKey(btn);   // marker moves only on a REAL launch
      applyWatching();
      postMovieEvent(btn);            // history/recommender counts real launches only
    }).catch(() => {
      if (el && el.isConnected) {
        el.classList.add("launch-failed");
        setTimeout(() => el.classList.remove("launch-failed"), 2000);
      }
    });
  }

  function applyPlaying(id) {
    const full = !!(music && music.isFull && music.isFull());
    for (const [sid, el] of songEls) {
      el.classList.toggle("playing", sid === id);
      el.classList.toggle("full-on", sid === id && full);   // "Full song ✓" strip
    }
    // the Full song tile itself acknowledges the mode too
    for (const el of area.querySelectorAll(".tile.type-full"))
      el.classList.toggle("active", !!id && full);
  }
  if (music) music.onState = applyPlaying;

  // --- board render ---
  function onTile(btn, el) {
    // barge-in: stop any speech FIRST, then act (every path stops before speaking).
    sp.stop && sp.stop();
    const type = (btn.type || "").toLowerCase();
    // Movies Board (spec 8/29 §5): a show tile is a DOOR to its show board
    // (episode picker) — silent nav, no launch, no event. movie/episode tiles
    // LAUNCH the streaming app via ERAgaze; the board itself never plays video.
    if (type === "show" && btn.board != null) {
      session.navigate(btn.board);
      render();
      return;
    }
    if (LAUNCH_TYPES.has(type)) { launchMovie(btn, el); return; }
    // Songs Board v2 (dad's 8/24 feedback): playback lives ONLY on a song's own
    // page. A grid song door opens that page AND starts the default clip; the
    // hero tile on the page replays the clip; Full song un-caps it; Stop is
    // silent; ANY nav that leaves the playing song's page stops the music —
    // which is why the grid has no Stop tile. One pick = one song, no queue.
    if (music && type === "song") {
      if (btn.load != null) {
        session.navigate(btn.load);   // grid door: silent, always a fresh clip
        music.play(btn);
        render();
        return;
      }
      // the HERO (dad r5): no-op while its song plays (she's looking at the
      // art), resume after Stop, fresh start only from silence.
      music.heroTap(btn);
      return;
    }
    if (music && type === "full") { music.full(btn); return; }
    if (music && type === "stop") { music.stop(); return; }
    if (btn.combo && (type === "outfit" || type === "yes")) {
      outfitEvents.send(type === "yes" ? "yes" : "select", btn.combo);
    }
    if (type === EXIT_TYPE) { if (music) music.stop(); exitToTDSnap(); return; }
    const r = session.activate(btn);
    // nav doors are SILENT by default; a door may voice itself as it navigates
    // (r.speak set) — the today-page outfit pick speaks then opens confirm.
    if (r.navigated != null) {
      // leaving the playing song's page = stop (the only playback context)
      if (music && music.playingId() && session.currentId !== "song-" + music.playingId()) music.stop();
      if (r.speak != null) sp.say && sp.say(r.speak);
      render(); return;
    }
    // append -> echo the single word (UX contract: "voice confirms everything").
    if (r.append) { appendChip(r.append); sp.say && sp.say(btn.say != null ? btn.say : btn.label); return; }
    if (r.speak != null) { sp.say && sp.say(r.speak); }
  }

  function render() {
    // page-settle (27P #5b): the surface is about to change under her gaze —
    // suppress dwell arming for settleMs so a fresh page never inherits it.
    if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(EC.dwellEngine.settleMs);
    const board = session.current;
    area.innerHTML = "";
    if (!board) { area.textContent = ""; return; }

    const availW = window.innerWidth - 2 * CONFIG.SIDE_PAD;
    const availH = window.innerHeight - CONFIG.BAR_H - 2 * CONFIG.V_PAD;
    const { rows, cols, slots } = layoutCells(board);
    const { w, h, gap } = gridFit(rows, cols, availW, availH);

    area.style.gridTemplateColumns = "repeat(" + cols + ", " + w + "px)";
    area.style.gridTemplateRows = "repeat(" + rows + ", " + h + "px)";
    area.style.gap = gap + "px";
    area.style.padding = CONFIG.V_PAD + "px " + CONFIG.SIDE_PAD + "px";

    const fits = [];
    songEls = new Map();
    movieEls = new Map();
    for (let i = 0; i < slots.length; i++) {
      const btn = slots[i];
      if (btn === TAKEN) continue;   // covered by a spanning neighbor
      const r = Math.floor(i / cols) + 1, c = (i % cols) + 1;
      const place = (el, rs, cs) => {
        el.style.gridRow = r + (rs > 1 ? " / span " + rs : "");
        el.style.gridColumn = c + (cs > 1 ? " / span " + cs : "");
        area.appendChild(el);
      };
      if (!btn) { place(restCell(), 1, 1); continue; }
      const rs = Math.max(1, btn.row_span | 0 || 1), cs = Math.max(1, btn.col_span | 0 || 1);
      // a spanning tile's real box includes the gaps it swallows
      const { el, fit } = makeTile(btn, w * cs + gap * (cs - 1), h * rs + gap * (rs - 1), contentDwellMs);
      el.addEventListener("click", () => onTile(btn, el));
      if ((btn.type || "").toLowerCase() === "song" && btn.song_id) songEls.set(btn.song_id, el);
      if (LAUNCH_TYPES.has((btn.type || "").toLowerCase()) && btn.titleId != null)
        movieEls.set(launchKey(btn), el);
      place(el, rs, cs);
      fits.push(fit);
    }
    // second pass: labels are only measurable once they are in the document.
    for (const fit of fits) fit();
    if (music) applyPlaying(music.playingId()); // marker survives page nav
    applyWatching();                            // .watching survives page nav too
  }

  syncControls();
  render();
  let rt = null;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });

  return {
    render,
    session,
    appendChip,
    clearBar,
    speakBar,
    get chips() { return chips.slice(); },
    // deep-link/testing hook: jump to a board id then render.
    show(id) { session.navigate(id); render(); return session.current; },
    home() { session.home(); render(); },
    back() { session.back(); render(); },
  };
}
