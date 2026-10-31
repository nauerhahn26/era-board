// board-render.js — DOM renderer (T1.2 + T1.3, post Gate-1 review).
// Fixed chrome: a SLIM top strip (<=9% of the viewport) holding only the two
// doors, and a board area below. Dad 9/2, matching Ellie's tablet:
// "get rid of speak/clear we aren't using it. The header is still too big. The
// icon for the exit can be smaller." The grid FILLS the remaining
// screen with wide rectangular tiles (TD Snap style): rows x cols stretch to the
// full area, packed at her own tablet's spacing (dad 9/5: 14px gap, 28px side
// pad, 12px vertical pad — all from the contract). Every empty cell is a black inert
// rest box; declared rows always render (never-empty bottom row).
//
// WORD INTEGRITY (Gate-1 core constraint — she is learning to read):
// labels NEVER break mid-word, NEVER hyphenate, NEVER clip. Wrapping happens at
// word boundaries only. Fit order per label: >=74px in the normal label area ->
// grow the label area -> (beside tiles) switch to stacked full-width -> only
// then reduce that one label's font, floor 44px (~32pt vision spec), marked
// data-font-reduced for the pixel gate.
//
// THE MESSAGE BAR IS NOT HERE ANY MORE (9/17). mountDoorBar moved to era-core
// (lib/doorbar.js + lib/doorbar.css) so all five of Ellie's apps wear ONE bar.
// BOARD LAW, amended by dad on 9/17: the bar carries TWO doors — 🚪 leave and
// 💬 pause-to-talk — and nothing else; they are its only dwell targets. The 9/4
// partner-strip amendment stands (touch-only, never .dwell). See era-core
// lib/doorbar.js's header and docs/board-design-rules.md.
//
// HOLDS, amended by dad on 9/17 (spec §5.1, era-core contract.js): there are
// TWO speeds and no ladder. The doors that take her off the screen hold
// holdForExit(dwell) = 2 x her Settings dwell; EVERYTHING else on the board —
// content tiles, nav doors, More/Back, movie and episode launches — holds
// exactly her dwell. The invented nav bonus/floor is gone.

import { CONTRACT as EC, holdForExit } from "../lib/contract.js";
import { mountDoorBar, barHeight } from "../lib/doorbar.js";
import { createOutfitEvents } from "./board-events.js";
import { isLocked, syncLock } from "./board-lock.js";

// the bar's own geometry lives with the bar now; re-exported under the name the
// board has always used so nothing downstream has to learn a second import.
export { barHeight };

// ---- one place for every tunable — VALUES COME FROM lib/contract.js (the
// whitelist; mirrors knowledge/ux-contract.md). CONFIG keeps the renderer's
// historical names so call sites read naturally; it holds no numbers of its own.
export const CONFIG = {
  // (the bar's height and its 9% fraction moved to era-core lib/doorbar.js with
  // the bar itself, 9/17 — one strip, one place to change it.)
  // dad 9/5 ("you put too much spacing between the tiles in the new build"):
  // the pads and the gap are Ellie's own tablet's, measured off her photo —
  // side 28, vertical 12, gap ~1% of screen width (14px at 1920). Tighter
  // spacing is what lets each tile be bigger; §24 was amended to match.
  SIDE_PAD: EC.sizes.sidePadBoard,
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
  // 14 left "Change bottoms" (15) stacked, where its two-line label crushed the
  // trousers picture to a speck on EVERY screen size while "Change top" beside
  // it showed a proper shirt (QA 9/2). Beside gives a wrapping label both a
  // real picture and its contract font; stacked can only give one.
  BESIDE_MAX_CHARS: 16,
  // dad 9/2 ("change bottoms image ... is too small", "make it match the images
  // I shared"): on her tablet EVERY pictogram tile is a BIG picture with the
  // word next to it. 430 kept beside for the roomy 2-column pages but dropped
  // the 4-column today page (a 1024-wide board gives 211px tiles) back to
  // stacked, where the picture is a speck above the word. Beside is now the
  // layout for any tile that can still hold the picture; a long word shrinks
  // the LABEL (and, if it must, the picture a little) instead.
  BESIDE_MIN_W: 190,
  ICON_SHARE: 0.42,   // picture's share of a beside tile's width
  ICON_SHARE_MIN: 0.30, // ...and the least it may yield to a cramped label
  WEATHER_ICON_SHARE: 0.45, // the weather plate leads with the sun/cloud (dad 9/2)
  // The weather plate's reading rides in its own, smaller band — dad's explicit
  // exception to the 74px text floor on 9/2 ("weather text is too big cannot
  // see sunny/cloudy image"; he asked for "roughly 40-48px each at 1024 wide").
  // The picture is the message here, exactly as on a photo tile's plate.
  WEATHER_FONT_MIN: 36,
  // Dwell hold (ms) — AMENDED 9/17 (dad's two-speeds ruling, spec §5.1). Every
  // tile on the grid holds her runtime /settings dwellMs: content tiles, nav
  // doors, More/Back, movie and episode launches alike. The one exception is a
  // grid `type:"exit"` tile, which leaves the app and so holds
  // holdForExit(dwell) like the bar's own doors. The old nav bonus/floor rungs
  // (DWELL_NAV_BONUS / DWELL_NAV_MIN / DWELL_EXIT) are GONE from the contract:
  // the field ships ONE dwell per user and only leaving the screen buys more.
  DWELL_DEFAULT: EC.holds.content, // fallback when /settings is unreachable
  // type -> tile background. rest black; yes green; outfit/clothing white;
  // control teal; category/back/more grey. (board-design-rules.md)
  // colors mirror lib/tokens.css primitives (CSS custom props can't cross into
  // this canvas-side map; tokens.css remains the palette of record)
  color: { rest: "#000000", yes: "#2E9E4B", outfit: "#FFFFFF", clothing: "#FFFFFF",
           control: "#0F7C8A", category: "#6B7B82", back: "#6B7B82", more: "#6B7B82",
           exit: "#6B7B82",
           word: "#FFFFFF",
           song: "#FFFFFF", stop: "#0F7C8A",     // Songs Board (spec 8/24)
           show: "#FFFFFF", movie: "#FFFFFF", episode: "#FFFFFF", // Movies (spec 8/29)
           link: "#FFFFFF" },  // This week's Play door: painted like the show doors beside it
  INK_DARK: "#17272E",
  INK_LIGHT: "#FFFFFF",
  // the section she is in, lit on the songs rail — the book shelf's coral
  // (lib/tokens.css --c-vowel), the colour the reader's rail lights its own with
  RAIL_CURRENT: "#DE7B52",
};

// tiles whose ink should be dark (light backgrounds)
const LIGHT_BG = new Set(["outfit", "clothing", "word", "song",
                          "show", "movie", "episode", "link"]);

// movie/episode tiles LAUNCH the streaming app via ERAgaze — the board never
// plays video (movies spec §5). Kept as a set because the ACTIVATION path still
// branches on it (launchMovie, the watching marker); since 9/17 it no longer
// buys a longer hold — a launch is a control like any other and holds her dwell.
const LAUNCH_TYPES = new Set(["movie", "episode"]);
// the EXIT tile leaves the app entirely (ERAgaze hands the screen to TD Snap) —
// the grid's own copy of the bar's 🚪, so it carries the bar's hold and fires
// the bar's door (phase 4.1; holds amended 9/17).
const EXIT_TYPE = "exit";

// A tile that takes THIS kiosk window to another page of this hub (spec
// 2026-10-12 §3.3 amended 10/21, §5.6): the This week `link` door (Play) and a
// READY `video` (its /watch/ page). Same origin only — a path that starts with
// one "/" and carries no "\", whitespace or angle bracket; anything else
// ("http://…", "//host", "javascript:…") is painted but inert. The recipe is
// trusted to draw; this rule is cheap and keeps it from aiming the window off
// the hub.
function safeHref(href) {
  return typeof href === "string" && href.startsWith("/") && !href.includes("//") &&
         !/[\\\s<>]/.test(href);
}
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
function videoHref(btn) {
  if (!WEEK_RE.test(String(btn.week_of)) || !VIDEO_ID_RE.test(String(btn.id))) return null;
  return "/watch/?w=" + btn.week_of + "&v=" + btn.id;
}

// dwellMs = her runtime hold (from /settings). Returns this tile's hold ms.
// TWO SPEEDS ONLY (dad 9/17): a tile that leaves the app holds 2 x dwell;
// everything else — content, nav doors, More/Back, launches — holds dwell.
function tileDwellMs(btn, type, dwellMs) {
  return type === EXIT_TYPE ? holdForExit(dwellMs) : dwellMs;
}

// ---- sizing math (pure) ----------------------------------------------------

// Fill-the-area grid: tiles are free-floating rectangles; rows x cols stretch to
// the available box with a fixed gap — the contract's gapFloor, which since 9/5
// is Ellie's own tablet's ~1% of screen width. (Gate-1: "use the screen".)
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
  // a This week video (spec 2026-10-12 §3.3): its downloaded thumbnail fills
  // the cell and the plate carries the title. A video cell with no image
  // paints like a movie without a poster (the icon/text path).
  if (btn.type === "video" && typeof btn.image === "string") return true;
  return typeof btn.image === "string" &&
         (btn.image.startsWith("wardrobe/") || btn.image.startsWith("music/") ||
          btn.image.startsWith("movies/") ||
          // the hub's Clothing Picker (item tiles, composite outfits, raw
          // photos pre-catalog) — these rendered as small icons, dad 8/29
          btn.image.startsWith("wardrobe-items/") || btn.image.startsWith("wardrobe-outfits/") ||
          btn.image.startsWith("clothing-web/"));
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

// Weather-plate fitting (dad 9/2): its own smaller band, walked down from
// startPx to WEATHER_FONT_MIN. Word integrity is unchanged — no horizontal
// overflow, nothing clipped; only the floor differs, because on this one tile
// the sun/cloud is the message and the reading rides beside it.
function applyWeatherFit(labelEl, maxH, startPx) {
  const fits = (f) => {
    labelEl.style.fontSize = f + "px";
    return labelEl.scrollWidth <= labelEl.clientWidth + 1 && labelEl.scrollHeight <= maxH;
  };
  let f = Math.max(CONFIG.WEATHER_FONT_MIN, Math.min(CONFIG.FONT_CAP, startPx));
  for (; f > CONFIG.WEATHER_FONT_MIN; f -= 2) if (fits(f)) break;
  if (f <= CONFIG.WEATHER_FONT_MIN) { f = CONFIG.WEATHER_FONT_MIN; fits(f); }
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

// The recipe button behind a rendered tile (T7, spec 2026-09-17 §4). The
// hold-to-edit sheet needs the WARDROBE ITEMS under a finger, and the one thing
// it must never do is read them off the label — "Heart tee + leggings" is a
// single string and two garments, and a name a grown-up corrects in the sheet
// would change the parse. A WeakMap rather than a dataset blob: the objects are
// the recipe's own ({id, name, category, occasion}), they die with the tile when
// the next render throws the grid away, and nothing has to serialise a family's
// clothing names into an attribute. The ids DO ride in `data-items`, because an
// attribute is the only thing a selector (and the sheet's arming filter) can
// match on.
const BTN_OF = new WeakMap();
export function tileButton(el) { return el ? BTN_OF.get(el) || null : null; }

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
  // The type in the DOM, not only in the class list (T3, 9/14): the media lock
  // has to pick the song/movie tiles out of a grid it did not build, and
  // `.type-song` is a STYLE hook — a selector built out of it would break the
  // day a board wants a song tile that is painted differently.
  el.dataset.tileType = type;
  // …and, on the tiles that NAME clothes, which clothes (T7, 9/17). Tiles with
  // no `items` — More, Back, Build my own, the Accessories door, the weather
  // plate, a raw pre-catalog photo — get neither the attribute nor the entry,
  // so `[data-items]` is the whole of the edit sheet's arming filter.
  BTN_OF.set(el, btn);
  if (Array.isArray(btn.items) && btn.items.length)
    el.dataset.items = btn.items.map((i) => i && i.id).filter(Boolean).join(",");
  el.dataset.dwellMs = String(tileDwellMs(btn, type, dwellMs));
  el.setAttribute("aria-label", btn.label || "");
  el.dataset.dwellSay = btn.say != null ? btn.say : (btn.label || "");
  if (type === "song" && btn.song_id) el.dataset.songId = btn.song_id;
  // A tile the recipe says goes nowhere right now (the songs rail's Back on a
  // section's page 1): dimmed, and out of the gaze's reach — no .dwell, and the
  // data-dwell-disabled dwell.js reads — while a finger's tap is ignored in
  // onTile. Without .dwell no sheet's freeze/thaw can ever wake it.
  if (btn.disabled) {
    el.classList.remove("dwell");
    el.classList.add("dimmed");
    el.setAttribute("data-dwell-disabled", "");
    el.setAttribute("aria-disabled", "true");
  }
  if (btn.current) el.classList.add("is-current");

  // A forecast remains a speaking control, with a quiet sage background.
  const isWeather = btn.footnote != null;
  const bg = isWeather ? "#CEDBD6" : btn.current ? CONFIG.RAIL_CURRENT
    : (CONFIG.color[type] || CONFIG.color.control);
  el.style.background = bg;
  el.style.color = (isWeather || LIGHT_BG.has(type)) ? CONFIG.INK_DARK : CONFIG.INK_LIGHT;

  // Movies board episode marks (spec §2 generator): "next" = the highlighted
  // next-unwatched episode; "again" = the last-watched, offered as a rewatch.
  // Pure CSS classes, same approach as the songs .playing marker.
  if (btn.mark === "next") el.classList.add("mark-next");
  else if (btn.mark === "again") el.classList.add("mark-again");

  const src = btn.image ? imageSrc(btn.image) : (btn.symbol ? symbolSrc(btn.symbol) : null);
  // The weather plate is the tile carrying the dad-only freshness stamp — the
  // only button in any recipe with a `footnote` (era-hub clothing-worker.js).
  // songs-board control tiles maximize their text (dad's round 3): start the
  // fitter at the cap and let it walk down, instead of the h*0.3 heuristic.
  // The weather plate starts LOW (dad 9/2: "weather text is too big cannot see
  // sunny/cloudy image") so "76°" over "warm" reads at the contract floor
  // rather than shouting over the sun.
  const startPx = (type === "stop" || type === "full") ? CONFIG.FONT_CAP
    : Math.round(h * (isWeather ? 0.24 : 0.3));

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
  // (big picture left, label right) on any tile wide enough; otherwise stacked.
  // With no image at all (e.g. a poster-less movie tile) "beside" would
  // left-shove a lone label — stacked centers it, pure text at contract sizes.
  // The weather plate leads with a 45%-wide sun/cloud and the reading rides
  // beside it, exactly like her tablet's plate (dad 9/2).
  const short = src != null &&
                (btn.label || "").length <= CONFIG.BESIDE_MAX_CHARS &&
                w >= CONFIG.BESIDE_MIN_W;
  el.classList.add("icon", short ? "beside" : "stacked");
  if (isWeather) el.classList.add("weather");
  let img = null;
  if (src) {
    img = document.createElement("img");
    img.className = "tile-img contain";
    img.src = src; img.alt = "";
    img.style.setProperty("--icon-w",
      Math.round(100 * (isWeather ? CONFIG.WEATHER_ICON_SHARE : CONFIG.ICON_SHARE)) + "%");
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
      const room = h - 24 - (isWeather ? 26 : 0);   // weather keeps its stamp line clear
      const run = () => (isWeather ? applyWeatherFit(lab, room, startPx)
                                   : applyFit(lab, [room], startPx));
      let f = run();
      if (!isWeather && f >= CONFIG.FONT_FLOOR) return f;
      // dad 9/2: a longer word shrinks the LABEL, not the picture. The old rule
      // bailed out to stacked right here — which is exactly what turned
      // "Change bottoms"/"Bottoms"/"Dresses" into a speck above a word while
      // "Change top" next to them showed a proper shirt. Under 74 is the
      // renderer's marked, fit-impossible fallback (data-font-reduced): it
      // happens on the small QA screens; the i13 has room for the contract font.
      if (lab.scrollWidth <= lab.clientWidth + 1) return f;
      // Only when the word will not fit even at the floor does the picture
      // yield — a little (ICON_SHARE_MIN), never back to a speck.
      if (img) {
        img.style.setProperty("--icon-w", Math.round(100 * CONFIG.ICON_SHARE_MIN) + "%");
        f = run();
        if (lab.scrollWidth <= lab.clientWidth + 1) return f;
        img.style.removeProperty("--icon-w");
      }
      // word integrity outranks layout: a word that cannot fit beside at any
      // size falls back to the full-width stacked tile.
      el.classList.remove("beside");
      el.classList.add("stacked");
    }
    return applyFit(lab, [h * 0.55, h * 0.80], startPx);
  };
  return { el, fit };
}

// .tile.icon's side padding in board.css — the room a text tile's label loses
// on each side. Kept beside the stylesheet's own number, never a new size.
const TEXT_TILE_SIDE_PAD = 12;

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

export function mountBoard({ mount, session, speech, dwellMs, music, pauseGoes }) {
  const sp = speech || { say() {}, stop() {} };
  // runtime content-tile hold from /settings (board.js clamps 600-3000).
  const contentDwellMs = (typeof dwellMs === "number" && isFinite(dwellMs))
    ? dwellMs : CONFIG.DWELL_DEFAULT;

  // chrome (built once — the strip's height is fixed per viewport => zero shift)
  // dad 9/2, holding her tablet next to the board: "get rid of speak/clear we
  // aren't using it. The header is still too big. The icon for the exit can be
  // smaller. Items in the top corners are more easily accessible." So the bar
  // is a slim strip carrying the doors and nothing else. Speak, Clear and the
  // chips strip that fed them are gone — no recipe the hub generates has ever
  // set `bar:true`, so nothing loses a feature.
  //
  // 💬 PAUSE TO TALK (dad 9/17): mid-song she looks at the second door, the
  // music stops WHERE IT IS and TD Snap comes forward; when the launcher hands
  // the screen back the page goes visible again and the same second plays on.
  // onPause/onResume are the board's half of that contract (spec §6); the bar
  // and the hub own the rest. mountBoard is called after /settings has landed
  // (board.js boot), so the real dwell and the real pauseGoes go on at mount.
  mount.innerHTML = "";
  // no `appPath`: the bar's default IS location.pathname + location.search read
  // at click time, which is what the launcher sends back on /kiosk/resume. The
  // board never rewrites its URL (?recipe= / ?board= are read once at boot), so
  // mount-time and click-time are the same string — and click-time cannot drift.
  const bar = mountDoorBar(mount, {
    onLock: () => { sp.stop && sp.stop(); if (music) music.stop(); },
    onLeave: () => { sp.stop && sp.stop(); if (music) music.stop(); },
    // she is going to TALK: go quiet and keep the place. NOT music.stop() —
    // stop() forgets the clip/full mode and posts a "stop" event; pause() holds
    // the element exactly where it is so resume() is the same second.
    onPause: () => { sp.stop && sp.stop(); if (music) music.pause(); },
    onResume: () => { if (music && !isLocked()) music.resume(); },
  });
  const sizeBar = bar.sizeBar;
  bar.setDwell(contentDwellMs);
  bar.setPause(pauseGoes === "tdsnap");

  const area = document.createElement("div");
  area.className = "board-area";
  mount.appendChild(area);

  // outfit pick telemetry (Phase 2, D49): recipe buttons carrying `combo` report
  // select (outfit tile) / yes (confirm) — fire-and-forget, offline-queued.
  const outfitEvents = createOutfitEvents();
  outfitEvents.flush(); // drain anything queued while the server was away

  // --- playing-song marker (Songs Board): the active song's tile carries
  // .playing so she can see what is on. Survives page nav via re-apply in render.
  const picturePositions = new Map();
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

  // The flag on the tile says "refused"; the banner says WHY. VM QA 9/5 (T7.6
  // bug 4): a touch-only family that unticked ERAgaze at install added Moana,
  // pressed it, watched the tile dim for two seconds and nothing else ever
  // happened — a Movies app that cannot play anything and never says so. The
  // hand-off design stands (a hub-side browser fallback is dad's call, plan
  // queue); this is the partner banner the other slow/broken states already
  // wear (#netWarn, #ttsWarn): touch only, never .dwell, gone on the next real
  // launch or after LAUNCH_WARN_MS on its own.
  const LAUNCH_WARN_MS = 12000;
  let launchWarnTimer = null;
  // "Above every standing footer" was only a z-index until review 9/5: the
  // banner painted ON #ttsWarn and #contentNote at the same 6px, and the
  // sentence under it was unreadable for the twelve seconds it stood. The
  // footers' CSS ladder cannot reach it (it precedes two of them in the DOM,
  // and a fixed rung would not clear a wrapped footer anyway — #ttsWarn is two
  // lines at 52vw), so it measures: 6px above the highest footer showing.
  const STANDING_FOOTERS = "#ttsWarn.show, #netWarn.show, #wardrobeNote.show, #contentNote.show";
  function footerClearance() {
    let top = window.innerHeight;
    for (const el of document.querySelectorAll(STANDING_FOOTERS)) {
      const r = el.getBoundingClientRect();
      if (r.height > 0) top = Math.min(top, r.top);
    }
    return Math.round(window.innerHeight - top) + 6;
  }
  function setLaunchWarn(on) {
    const w = document.getElementById("launchWarn");
    if (!w) return;
    clearTimeout(launchWarnTimer); launchWarnTimer = null;
    if (on) w.style.bottom = footerClearance() + "px";
    w.classList.toggle("show", on);
    if (on) launchWarnTimer = setTimeout(() => w.classList.remove("show"), LAUNCH_WARN_MS);
  }

  // A wedged engine — up, taking the socket, never answering — is the other
  // way bug 4 shows: with no deadline the fetch never settles, so neither the
  // flag nor the banner ever comes and a press does nothing for ever (review
  // 9/5). ERAgaze replies BEFORE it spawns the kiosk (ERAgaze.cs /app/launch:
  // "Reply FIRST"), so a real launch is a few ms; 4 s is only for the wedge.
  const LAUNCH_DEADLINE_MS = 4000;

  function launchMovie(btn, el) {
    if (isLocked()) return;
    const body = { url: btn.url, watch: true, titleId: btn.titleId };
    if (btn.episode) body.episode = btn.episode;
    const nx = nextEpisodeOf(btn);
    if (nx) body.next = nx;
    fetch("http://127.0.0.1:49155/app/launch", {
      method: "POST", body: JSON.stringify(body),
      signal: AbortSignal.timeout(LAUNCH_DEADLINE_MS),
    }).then((r) => {
      if (!r.ok) throw new Error("launch " + r.status);
      setLaunchWarn(false);           // the engine answered: the explanation is stale
      watchingKey = launchKey(btn);   // marker moves only on a REAL launch
      applyWatching();
      postMovieEvent(btn);            // history/recommender counts real launches only
    }).catch(() => {
      if (el && el.isConnected) {
        el.classList.add("launch-failed");
        setTimeout(() => el.classList.remove("launch-failed"), 2000);
      }
      setLaunchWarn(true);
    });
  }

  // This week (spec 2026-10-12 §3.3 amended 10/21): a `link` door and a READY
  // video both take THIS window to a page of this hub — nothing is launched,
  // so nothing can open twice. (Phase 1 handed the /watch/ page to ERAgaze;
  // on 10/13 the tile stayed under the gaze ring while the second kiosk was
  // still appearing and the launch fired four times in four seconds.) The tile
  // leaves the gaze's reach first — belt and braces, the page is going.
  function leaveTo(href, el) {
    if (isLocked()) return;
    if (el) el.setAttribute("data-dwell-disabled", "");
    location.assign(href);
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

  function showPicture(btn, el, index) {
    const pictures = Array.isArray(btn.pictures) ? btn.pictures : [];
    if (pictures.length !== 10 || !pictures.every(p => /^music\/[a-z0-9-]+-frame-[a-f0-9]{16}-[0-9]{2}\.jpg$/.test(p))) return;
    const img = el.querySelector(".photo-img");
    if (!img || !music.pictureBlob) return;
    const generation = (el._pictureGeneration || 0) + 1;
    el._pictureGeneration = generation;
    music.pictureBlob(pictures[index]).then(blob => {
      if (!blob || !el.isConnected || el._pictureGeneration !== generation) return;
      const next = URL.createObjectURL(blob);
      const probe = new Image();
      probe.onload = () => {
        if (!el.isConnected || el._pictureGeneration !== generation) { URL.revokeObjectURL(next); return; }
        if (el._pictureUrl) URL.revokeObjectURL(el._pictureUrl);
        el._pictureUrl = next;
        img.src = next;
        el.dataset.pictureIndex = String(index);
        picturePositions.set(btn.song_id, index);
      };
      probe.onerror = () => URL.revokeObjectURL(next);
      probe.src = next;
    }).catch(() => {});
  }

  // --- board render ---
  let voicedOnLoad = false;   // see render(): a board's own say_on_load, once

  function onTile(btn, el) {
    if (isLocked()) return;
    if (btn.disabled) return;                    // a dimmed rail Back: a finger's tap goes nowhere too
    const type = (btn.type || "").toLowerCase();
    // barge-in: stop any speech FIRST, then act (every path stops before speaking).
    sp.stop && sp.stop();
    // Movies Board (spec 8/29 §5): a show tile is a DOOR to its show board
    // (episode picker) — silent nav, no launch, no event. movie/episode tiles
    // LAUNCH the streaming app via ERAgaze; the board itself never plays video.
    if (type === "show" && btn.board != null) {
      session.navigate(btn.board);
      render();
      return;
    }
    if (LAUNCH_TYPES.has(type)) { launchMovie(btn, el); return; }
    if (type === "video") { const h = videoHref(btn); if (h) leaveTo(h, el); return; }
    if (type === "link") { if (safeHref(btn.href)) leaveTo(btn.href, el); return; }
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
      // One completed dwell advances a still while the audio keeps its place.
      // After Stop/end the existing resume/replay action remains available.
      if (music.playingId() === btn.song_id && (!music.isPlaying || music.isPlaying())) {
        const current = Number(el.dataset.pictureIndex || 0);
        showPicture(btn, el, (current + 1) % 10);
      }
      music.heroTap(btn);
      return;
    }
    // A song page's Back (spec 2026-10-31) returns to the section page she
    // came from — the page under it on the session's history — and only
    // falls back to its `load` (the song's page in All) when the page was
    // opened directly. Leaving the song page is stop, as ever.
    if (type === "back" && btn.return && session.history.length) {
      session.back();
      if (music && music.playingId() && session.currentId !== "song-" + music.playingId()) music.stop();
      render(); return;
    }
    if (music && type === "full") { music.full(btn); return; }
    if (music && type === "stop") { music.stop(); return; }
    if (btn.combo && (type === "outfit" || type === "yes")) {
      outfitEvents.send(type === "yes" ? "yes" : "select", btn.combo);
    }
    // a grid `type:"exit"` tile is the bar's 🚪 seated in the grid — so it IS
    // the bar's door: one round trip, one place it can change. (The exit's own
    // fetch lived here until 9/17; it moved to era-core lib/doorbar.js with the
    // bar, and clicking the door runs onLeave — sp.stop + music.stop — first.)
    if (type === EXIT_TYPE) { bar.doorBtn.click(); return; }
    const r = session.activate(btn);
    // nav doors are SILENT by default; a door may voice itself as it navigates
    // (r.speak set) — the today-page outfit pick speaks then opens confirm.
    if (r.navigated != null) {
      // leaving the playing song's page = stop (the only playback context)
      if (music && music.playingId() && session.currentId !== "song-" + music.playingId()) music.stop();
      if (r.speak != null) sp.say && sp.say(r.speak);
      render(); return;
    }
    // `bar:true` leaf: with the message bar reduced to the exit door (dad 9/2)
    // there is nowhere to append, so it simply echoes the word — the UX
    // contract's "voice confirms everything" still holds.
    if (r.append) { sp.say && sp.say(btn.say != null ? btn.say : btn.label); return; }
    if (r.speak != null) { sp.say && sp.say(r.speak); }
  }

  // The widest single word on the rail at FONT_MIN, plus a text tile's side
  // padding: the narrowest rail that never has to break or clip a word.
  function railWordNeed(rail) {
    const probe = document.createElement("span");
    probe.className = "tile-label";
    probe.style.cssText = "position:absolute; visibility:hidden; white-space:nowrap; font-size:" + CONFIG.FONT_MIN + "px";
    area.appendChild(probe);
    let widest = 0;
    for (const b of rail) for (const word of String(b.label || "").split(/\s+/)) {
      probe.textContent = word;
      widest = Math.max(widest, probe.getBoundingClientRect().width);
    }
    probe.remove();
    return Math.ceil(widest) + 2 * TEXT_TILE_SIDE_PAD + 2;
  }

  function render() {
    // page-settle (27P #5b): the surface is about to change under her gaze —
    // suppress dwell arming for settleMs so a fresh page never inherits it.
    if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(EC.dwellEngine.settleMs);
    const board = session.current;
    area.innerHTML = "";
    if (!board) { area.textContent = ""; return; }
    // A board may voice ITSELF once as it opens (This week, spec 2026-10-12:
    // there is no title row, so the root's first button carries
    // `say_on_load: "This week: <title>"` as a STRING). Once per mount — a
    // resize, an ETag swap or coming Back never repeats it. (The boolean form
    // on a `load` door is a different thing: board-model's speak-as-it-opens.)
    if (!voicedOnLoad) {
      voicedOnLoad = true;
      const v = (board.buttons || []).find((c) => c && typeof c.say_on_load === "string" && c.say_on_load);
      if (v) sp.say && sp.say(v.say_on_load);
    }

    // the slimmer bar hands its old height back to the GRID (dad 9/2: the
    // tiles grow, the gaps do not — GAP stays at the contract floor).
    const availW = window.innerWidth - 2 * CONFIG.SIDE_PAD;
    const availH = window.innerHeight - sizeBar() - 2 * CONFIG.V_PAD;
    const { rows, cols, slots } = layoutCells(board);
    // THE RAIL (songs board, spec 2026-10-31 — the book shelf's shape): a
    // left column one grid column wide, its tiles stacked top to bottom with
    // the grid's own gap and filling the grid's height. The grid's cells sit
    // one column to the right; every size here is the contract's.
    const rail = Array.isArray(board.rail) && board.rail.length ? board.rail : null;
    const lead = rail ? 1 : 0;
    let { w, h, gap } = gridFit(rows, cols + lead, availW, availH);
    // Word integrity outranks an even split: a rail word that would not fit
    // its tile even at the contract's absolute minimum widens the rail just
    // enough (the grid's columns give it back). At 1920 wide a grid column is
    // already plenty; on a 1280 screen "Favorites" needs a few pixels more.
    let railW = w;
    if (rail) {
      railW = Math.max(w, railWordNeed(rail));
      if (railW > w) w = Math.max(60, Math.floor((availW - railW - cols * gap) / cols));
    }

    area.style.gridTemplateColumns = (rail ? railW + "px " : "") + "repeat(" + cols + ", " + w + "px)";
    area.style.gridTemplateRows = "repeat(" + rows + ", " + h + "px)";
    area.style.gap = gap + "px";
    area.style.padding = CONFIG.V_PAD + "px " + CONFIG.SIDE_PAD + "px";

    const fits = [];
    for (const el of songEls.values()) if (el._pictureUrl) URL.revokeObjectURL(el._pictureUrl);
    songEls = new Map();
    movieEls = new Map();
    if (rail) {
      const col = document.createElement("div");
      col.className = "rail";
      col.style.gridRow = "1 / span " + rows;
      col.style.gridColumn = "1";
      col.style.gap = gap + "px";
      col.style.gridTemplateRows = "repeat(" + rail.length + ", minmax(0, 1fr))";
      const railH = Math.floor((rows * h + (rows - 1) * gap - (rail.length - 1) * gap) / rail.length);
      area.appendChild(col);
      for (const btn of rail) {
        const { el, fit } = makeTile(btn, railW, railH, contentDwellMs);
        el.addEventListener("click", () => onTile(btn, el));
        col.appendChild(el);
        fits.push(fit);
      }
    }
    for (let i = 0; i < slots.length; i++) {
      const btn = slots[i];
      if (btn === TAKEN) continue;   // covered by a spanning neighbor
      const r = Math.floor(i / cols) + 1, c = (i % cols) + 1;
      const place = (el, rs, cs) => {
        el.style.gridRow = r + (rs > 1 ? " / span " + rs : "");
        el.style.gridColumn = (c + lead) + (cs > 1 ? " / span " + cs : "");
        el.dataset.cell = r + "," + c;   // the board's own [row,col], rail or not
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
      if (music && btn.type === "song" && btn.load == null)
        showPicture(btn, el, picturePositions.get(btn.song_id) || 0);
      fits.push(fit);
    }
    // second pass: labels are only measurable once they are in the document.
    for (const fit of fits) fit();
    if (music) applyPlaying(music.playingId()); // marker survives page nav
    applyWatching();                            // .watching survives page nav too
    syncLock();                                 // …and so does the media lock (9/14)
  }

  render();
  let rt = null;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });

  return {
    render,
    session,
    area,
    // deep-link/testing hook: jump to a board id then render.
    show(id) { session.navigate(id); render(); return session.current; },
    home() { session.home(); render(); },
    back() { session.back(); render(); },
  };
}
