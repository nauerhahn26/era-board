// board-edit.js — the hold-to-edit sheet (T8, spec 2026-09-17 §4.2).
//
// Dad 9/17: "How can the AI categorize items purely based on photos, and can
// there be a user override without too many changes to UX — the touch-only long
// touch could allow modifications." So: a grown-up holds a FINGER on any tile
// that names clothes for 1.6 s and gets a sheet that can move an item to
// another category, mark it fancy, or take it off the board. 9/29 (warmth
// coherence spec D4): and say how it is cut — Sleeves, Legs, Weight. The model filed a
// hoodie as a top; this is the one place a human overrules it, and the hub keeps
// that correction forever (`manual: true`, spec §3.4).
//
// WHY TOUCH ONLY, AGAIN. ERAgaze moves the REAL cursor, so a parked gaze and a
// parked mouse are the same pointer at the DOM. A hold that answered `mouse`
// would be a sheet SHE could open by looking at her own clothes for two
// seconds. `pointerType === "touch"` is the entire filter — the same one
// board-lock.js uses, for the same reason.
//
// WHY THIS LISTENS ON `window`, IN CAPTURE. era-core/dwell.js has a TAP-RESCUE:
// its own document-capture `pointerdown` remembers `e.target.closest(".dwell")`
// and, on release, fires `el.click()` 150 ms later — the click Windows owes a
// long press. A tile IS a .dwell, so without this every abandoned hold would
// send her to the confirm page and every completed hold would fire the tile
// underneath the sheet. Removing .dwell inside our own handler is only worth
// anything if we get there FIRST, and the capture path is window → document →
// … : a capture listener on `window` runs before dwell.js's on `document`.
// dwell.js then finds no .dwell, records no tap, and schedules no rescue.
//
// AND WHY IT NEVER TOUCHES A TAP. board-lock.js calls `preventDefault()` on the
// pointerdown, which it can afford: a tap on 🔒 is meant to do nothing. A tap on
// a TILE is her board — the outfit she picked, the garment whose name she wanted
// to hear (board-input.test.mjs drives these very tiles) — so the native click
// path is left completely alone and the browser's own tap keeps working on every
// platform. What this module does instead is SWALLOW the click on the way out of
// a press that was a HOLD: the one a completed hold sends into whatever is now
// under the finger (board-lock.js met the same release-click with its keypad,
// 9/16), and the one an ABANDONED long press would otherwise turn into a pick.
// A quick tap is never swallowed and never replayed — it is simply not ours.
// The Windows press-and-hold furniture that preventDefault would have covered is
// handled where it belongs: `contextmenu` here, and touch-action / user-select /
// -webkit-touch-callout on `.tile[data-items]` in board.css.
//
// FOURTH FREEZE OWNER. board-partner.js, board-arrange.js and board-lock.js
// each keep their OWN list of what they disarmed, because three switches over
// one list would mean the last one to close wakes everything the other two put
// to sleep. This is the fourth, and it plays by the same rule: it only ever
// takes tiles that still HAVE .dwell (so a tile another owner already froze is
// never claimed), and it hands back only those. Both DOORS are exempt — 🚪
// leave and 💬 pause-to-talk — because the way out is never taken away from her,
// not for a grown-up's sheet (board-partner.js's law, 9/5 and 9/17).

import { tileButton } from "./board-render.js";

// The finger hold. This is the TWIN of board-lock.js's HOLD_MS: one number a
// grown-up has learned, in two modules that must not drift. Change one and
// change the other. (It is not the dwell contract's business — a gaze never
// opens this.)
const HOLD_MS = 1600;
// Past ~600 ms Windows has committed the touch to its press-and-hold gesture
// and stops owing the page a click (era-core/dwell.js's own comment). That is
// the honest line between a tap and an abandoned hold: shorter than this and
// the browser's own click is hers, untouched; longer and the press was a hold
// that changed its mind, which fires nothing at all (spec §4.2) — so the click
// Chromium still sends on release is swallowed.
const TAP_MAX_MS = 600;
// A test may speed up the wait for the hub's rebuild; production never does.
const OV = (typeof window !== "undefined" && window.__editTest) || {};
const POLL_MS = Number(OV.pollMs) > 0 ? Number(OV.pollMs) : 1000;
const WAIT_MS = Number(OV.waitMs) > 0 ? Number(OV.waitMs) : 60000;
const OFFLINE = "Couldn't reach the hub — try again in a moment.";

// The standing footers this sheet has to clear, and the measurement that does
// it. TWIN of board-render.js's STANDING_FOOTERS/footerClearance (and of
// board-lock.js's copy) — the three are meant to agree, so change one and
// change the others. Copied rather than imported for the same reason the lock
// copies it: board-render.js is upstream of this module, and an import back the
// other way would be a cycle for nine lines of arithmetic.
const STANDING_FOOTERS = "#ttsWarn.show, #netWarn.show, #wardrobeNote.show, #contentNote.show, #lockWarn.show";
function footerClearance() {
  let top = window.innerHeight;
  for (const el of document.querySelectorAll(STANDING_FOOTERS)) {
    const r = el.getBoundingClientRect();
    if (r.height > 0) top = Math.min(top, r.top);
  }
  return Math.round(window.innerHeight - top) + 6;
}

// ---- the fit rows (9/29) ---------------------------------------------------
//
// Warmth coherence spec 2026-09-29 D4. Dad, on an 81 °F morning: "multiple
// options that were long sleeve and pants." The deal now reads how a garment
// is CUT — `coverage` (sleeves), `legs` (a dress or set's), `weight` (how warm
// a long sleeve or a jacket is) — and the model that reads a photo for those
// can be wrong exactly as it was about the hoodie, so this sheet overrules it
// the same way. The values are the hub's words (spec §3), the labels a
// parent's; the hub stores `mid` and the chip says Medium. There is no
// "Not sure" chip: `unsure` is the model's answer, never a parent's (§3), so an
// item that holds it shows nothing selected and sends nothing until a grown-up
// picks. Which rows a garment gets is decided from what is chosen IN THE SHEET
// — a top tapped Long grows a Weight row, a top moved to Pants loses its
// Sleeves — so `show` reads the row's live state, never the item it came from.
const FIT_FIELDS = [
  { field: "coverage", label: "Sleeves",
    opts: [["sleeveless", "Sleeveless"], ["short", "Short"], ["long", "Long"]],
    show: (r) => r.category === "top" || r.category === "dress" || r.category === "set" },
  { field: "legs", label: "Legs",
    opts: [["bare", "Bare"], ["covered", "Covered"]],
    show: (r) => r.category === "dress" || r.category === "set" },
  // a long-sleeve top or a jacket, and nothing else (D4): a short sleeve is
  // one weight in the model's table, and asking would be a question with no
  // consequence.
  { field: "weight", label: "Weight",
    opts: [["light", "Light"], ["mid", "Medium"], ["heavy", "Heavy"]],
    show: (r) => r.category === "jacket" || (r.category === "top" && r.coverage === "long") },
];
// Read defensively: until the hub's itemRef carries these (Phase 3) they are
// simply absent, and a word the sheet has no chip for (the model's `unsure`,
// or anything newer than this board) is shown as nothing selected rather than
// guessed at.
function fitValue(f, v) {
  return f.opts.some(([id]) => id === v) ? v : "";
}

// ---- module state ----------------------------------------------------------

let mounted = false;
let categories = [];      // [{id, label}] from the recipe root — never a list of ours
let watcher = null;       // board.js's ETag watcher: {checkNow()}
let frozen = [];          // the dwell targets THIS sheet put to sleep, and only those
let sheet = null;         // the open sheet, or null
let rows = [];            // the sheet's editable state, one per item
let pollTimer = null;
let gridWatch = null;     // re-freeze after a render under an open sheet
let press = null;         // the finger we are tracking: {el, t0, id, hadDwell, fired, ended, swallow}
let holdTimer = null;

const BAR_DOORS = new Set(["barDoor", "barTalk"]);

// ---- freeze / thaw ---------------------------------------------------------

function freeze() {
  const fresh = [...document.querySelectorAll(".board-area .dwell")]
    .filter((el) => !BAR_DOORS.has(el.id) && !(sheet && sheet.contains(el)));
  for (const el of fresh) {
    el.classList.remove("dwell");
    el.setAttribute("data-dwell-disabled", "");
    frozen.push(el);
  }
}

function thaw() {
  for (const el of frozen) {
    if (!el.isConnected) continue;       // it went with a re-render: nothing to wake
    el.classList.add("dwell");
    el.removeAttribute("data-dwell-disabled");
  }
  frozen = [];
  // a finger (or a gaze) may be parked on a tile as the sheet closes: give the
  // board a settle window so it does not inherit a hold nobody started — the
  // courtesy arrange mode, the partner sheet and the lock all pay on the way out.
  try { if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(600); } catch { /* bare page */ }
}

// ---- the hold --------------------------------------------------------------

const tileOf = (target) => (target && target.closest)
  ? target.closest(".board-area .tile[data-items]") : null;

function inside(el, e) {
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

function disarm(p) {
  if (!p.hadDwell) return;
  p.el.classList.remove("dwell");
  p.el.setAttribute("data-dwell-disabled", "");
}
function rearm(p) {
  if (!p.hadDwell || !p.el.isConnected) return;
  p.el.classList.add("dwell");
  p.el.removeAttribute("data-dwell-disabled");
}

function onDown(e) {
  // Mouse and pen do nothing — see the header: gaze IS the mouse here.
  if (e.pointerType !== "touch") return;
  if (sheet || press) return;                 // one finger, one sheet
  const el = tileOf(e.target);
  if (!el) return;
  const btn = tileButton(el);
  if (!btn || !Array.isArray(btn.items) || !btn.items.length) return;
  // NO preventDefault (see the header): the browser's own tap is hers and is
  // left exactly as it was. The contextmenu handler below is the half of the
  // Windows press-and-hold gesture that does have to be refused.
  press = { el, t0: Date.now(), id: e.pointerId, fired: false, ended: false, swallow: false,
            hadDwell: el.classList.contains("dwell") };
  disarm(press);                              // …before dwell.js's pointerdown looks
  el.classList.add("holding");
  // the fill ring runs on the CSS side off this one custom property, so the
  // hold length is stated once, here, from the contract.
  el.style.setProperty("--hold-ms", HOLD_MS + "ms");
  clearTimeout(holdTimer);
  holdTimer = setTimeout(fire, HOLD_MS);
}

function stopRing(p) {
  p.el.classList.remove("holding");
  p.el.style.removeProperty("--hold-ms");
}

// pointerup / pointercancel / pointerleave — the lock's cancel set exactly. On
// a touch pointer Chromium takes IMPLICIT POINTER CAPTURE at pointerdown, so
// boundary events are suppressed for the duration and a finger that drifts a
// few px inside a 300 px tile never sees `pointerleave` at all; the release
// point is checked against the tile's own box instead, the way dwell.js's
// inHalo() checks a tap.
function onEnd(e) {
  if (!press || press.ended) return;
  if (e && e.pointerId != null && e.pointerId !== press.id) return;
  // The lock listens on its own button; this listens on `window` (it has to —
  // see the header), so `pointerleave` arrives here for every element on the
  // page. Only the pressed tile's own leave is this press's business.
  if (e && e.type === "pointerleave" && e.target !== press.el) return;
  clearTimeout(holdTimer); holdTimer = null;
  const p = press;
  p.ended = true;
  if (!p.fired) {
    stopRing(p);
    rearm(p);
    // A QUICK press is still a tap: her board is not hold-only, so the browser's
    // own click goes through untouched and nothing here has an opinion about it.
    // A LONG one that was let go is a hold that changed its mind — it fires
    // NOTHING (spec §4.2), which on Chromium means eating the click the touch
    // sequence sends anyway. (On Windows past ~600 ms there is no click to eat,
    // and dwell.js's tap-rescue — the thing that would have invented one — never
    // saw a .dwell to remember. Both platforms end in the same silence.)
    const held = Date.now() - p.t0;
    if (held >= TAP_MAX_MS || !e || e.type !== "pointerup" ||
        !p.el.isConnected || !inside(p.el, e)) p.swallow = true;
    try { if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(600); } catch { /* bare page */ }
  }
  // Keep the claim alive a moment after the release: the click is still on its
  // way, and it belongs to this press, not to the board. It arrives in the same
  // breath as the pointerup, so the window is short on purpose — a grown-up
  // reaching straight for a chip on the sheet that just opened must not have
  // that tap eaten by a click that never came (Windows past ~600 ms sends none).
  p.swallowUntil = Date.now() + 250;
  setTimeout(() => { if (press === p) press = null; }, 500);
}

// The release click of a hold lands on whatever is under the finger by then —
// the tile, or the sheet that just opened over it (board-lock.js's keypad met
// exactly this and answered it the same way). So a press that was a HOLD eats
// every click until it is well and truly over; a press that was a TAP eats none.
function onClick(e) {
  if (!press || !press.swallow) return;
  // ONE click, and only one, and only in the breath after the release: the very
  // next tap is a grown-up reaching for a chip on the sheet that just opened.
  if (press.swallowUntil && Date.now() > press.swallowUntil) { press.swallow = false; return; }
  press.swallow = false;
  e.preventDefault();
  e.stopPropagation();
}

function onContextMenu(e) {
  if (!press || press.ended) return;
  if (tileOf(e.target) === press.el) e.preventDefault();
}

function fire() {
  holdTimer = null;
  if (!press || press.ended) return;
  press.fired = true;
  press.swallow = true;          // the release click belongs to the hold, not the board
  stopRing(press);
  const btn = tileButton(press.el);
  const items = (btn && Array.isArray(btn.items)) ? btn.items.filter((i) => i && i.id) : [];
  // Hand the armed tile back first, so freeze() claims it like every other tile
  // and thaw() gives it back with them. One list, one owner, no special case.
  rearm(press);
  if (!items.length) return;
  openSheet(items);
}

// ---- the sheet -------------------------------------------------------------

function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (tag === "button") el.type = "button";     // deliberately NO .dwell, NO data-dwell-*
  if (text != null) el.textContent = text;
  return el;
}

function setMsg(text) {
  if (!sheet) return;
  const m = sheet.querySelector(".edit-msg");
  if (m) { m.textContent = text || ""; m.classList.toggle("show", !!text); }
}

function enable(on) {
  if (!sheet) return;
  for (const b of sheet.querySelectorAll("button")) b.disabled = !on;
}

function openSheet(items) {
  if (sheet) return;
  rows = items.map((it) => {
    const row = {
      id: it.id,
      name: it.name || it.id,
      category: it.category || "",
      fancy: it.occasion === "fancy",
      hidden: !!it.hidden,
      was: { category: it.category || "", fancy: it.occasion === "fancy", hidden: !!it.hidden },
    };
    for (const f of FIT_FIELDS) row[f.field] = row.was[f.field] = fitValue(f, it[f.field]);
    return row;
  });

  sheet = mk("div", null);
  sheet.id = "editSheet";
  sheet.setAttribute("role", "dialog");
  const card = mk("div", "edit-card");
  const title = mk("div", "edit-title",
    rows.length > 1 ? "Fix these clothes" : "Fix this item");
  card.append(title);

  for (const row of rows) {
    const el = mk("div", "edit-row");
    el.dataset.itemId = row.id;
    const img = document.createElement("img");
    img.className = "edit-thumb";
    // the same path the tiles use (board-render.js imageSrc): the item's own
    // cut-out, by id — never a name, which is the one thing a grown-up may be
    // here to change.
    img.src = "/wardrobe-items/" + encodeURIComponent(row.id) + ".jpg";
    img.alt = "";
    const main = mk("div", "edit-main");
    // textContent, never innerHTML: an item's name is family text written by a
    // model out of a photo, and the only untrusted string on this sheet.
    main.append(mk("div", "edit-name", row.name));

    const chips = mk("div", "edit-chips");
    for (const c of categories) {
      if (!c || !c.id) continue;
      const b = mk("button", "edit-chip", c.label || c.id);
      b.dataset.cat = c.id;
      if (c.id === row.category) b.classList.add("on");
      b.addEventListener("click", () => {
        row.category = c.id;
        for (const other of chips.querySelectorAll(".edit-chip"))
          other.classList.toggle("on", other.dataset.cat === row.category);
        drawFit(row, fit);           // a new category may take or grow a fit row
      });
      chips.append(b);
    }
    if (categories.length) main.append(chips);

    // Sleeves · Legs · Weight (9/29) — between the category and the toggles,
    // because which of them show is the category's business.
    const fit = mk("div", "edit-fit");
    drawFit(row, fit);
    main.append(fit);

    const toggles = mk("div", "edit-toggles");
    const fancy = mk("button", "edit-fancy", "✨ Fancy");
    fancy.classList.toggle("on", row.fancy);
    fancy.addEventListener("click", () => { row.fancy = !row.fancy; fancy.classList.toggle("on", row.fancy); });
    const hide = mk("button", "edit-hide", "🚫 Hide from board");
    hide.classList.toggle("on", row.hidden);
    hide.addEventListener("click", () => { row.hidden = !row.hidden; hide.classList.toggle("on", row.hidden); });
    toggles.append(fancy, hide);
    main.append(toggles);

    el.append(img, main);
    card.append(el);
  }

  const msg = mk("div", "edit-msg");
  const foot = mk("div", "edit-foot");
  const cancel = mk("button", "edit-btn", "Cancel");
  cancel.id = "editCancel";
  cancel.addEventListener("click", () => close());
  const ok = mk("button", "edit-btn primary", "Done");
  ok.id = "editDone";
  ok.addEventListener("click", () => { save(); });
  foot.append(cancel, ok);
  card.append(msg, foot);
  sheet.append(card);
  document.body.appendChild(sheet);
  sheet.style.bottom = footerClearance() + "px";

  freeze();
  // A render under an open sheet hands back fresh tiles that all wear .dwell —
  // a resize, or board-render's own re-render. board-arrange.js met this first
  // and answered it the same way: watch the grid and put the new tiles straight
  // back to sleep (plan STOP (a)).
  const area = document.querySelector(".board-area");
  if (area && window.MutationObserver) {
    gridWatch = new MutationObserver(() => { if (sheet) freeze(); });
    gridWatch.observe(area, { childList: true });
  }
  window.addEventListener("resize", onResize);
}

// The fit rows for one item, drawn from scratch every time the category or
// the sleeves move. A row that does not apply is NOT IN THE DOM — not hidden:
// every control on this sheet is a 56 px finger target (the suite measures
// each button), and a display:none button is a 0 px one. Chips are plain
// buttons like the category chips, with their own class so a category is
// never counted among them.
function drawFit(row, host) {
  host.textContent = "";
  for (const f of FIT_FIELDS) {
    if (!f.show(row)) continue;
    const line = mk("div", "edit-field");
    line.dataset.field = f.field;
    line.append(mk("span", "edit-label", f.label));
    for (const [id, label] of f.opts) {
      const b = mk("button", "edit-opt", label);
      b.dataset.value = id;
      if (row[f.field] === id) b.classList.add("on");
      b.addEventListener("click", () => {
        row[f.field] = id;
        // only Sleeves can change which rows show (Long grows Weight); the
        // others just move their own highlight
        if (f.field === "coverage") { drawFit(row, host); return; }
        for (const other of line.querySelectorAll(".edit-opt"))
          other.classList.toggle("on", other.dataset.value === id);
      });
      line.append(b);
    }
    host.append(line);
  }
}

function onResize() {
  if (sheet) sheet.style.bottom = footerClearance() + "px";
}

function close() {
  clearTimeout(pollTimer); pollTimer = null;
  if (gridWatch) { gridWatch.disconnect(); gridWatch = null; }
  window.removeEventListener("resize", onResize);
  if (sheet) { sheet.remove(); sheet = null; }
  rows = [];
  thaw();
}

// Only the fields a grown-up MOVED, and only the rows that moved at all: an
// untouched row is not a request, and the hub's `manualAt` stamp is a promise
// that outlives the model — it is not something to spend on a row nobody edited.
function changesOf(row) {
  const body = { id: row.id };
  let any = false;
  if (row.category && row.category !== row.was.category) { body.category = row.category; any = true; }
  if (row.fancy !== row.was.fancy) { body.occasion = row.fancy ? "fancy" : "everyday"; any = true; }
  if (row.hidden !== row.was.hidden) { body.hidden = row.hidden; any = true; }
  // A fit field travels only if its row is ON SCREEN at Done and a grown-up
  // moved it (9/29). A top made Long and Heavy and then moved to Pants shows
  // no Sleeves or Weight any more, so what they held is not this garment's
  // business; and an empty value (nothing chosen) is never sent.
  for (const f of FIT_FIELDS) {
    const v = row[f.field];
    if (f.show(row) && v && v !== row.was[f.field]) { body[f.field] = v; any = true; }
  }
  return any ? body : null;
}

async function save() {
  const bodies = rows.map(changesOf).filter(Boolean);
  if (!bodies.length) { close(); return; }
  setMsg("");
  enable(false);
  for (const body of bodies) {
    let res = null;
    try {
      res = await fetch("/clothing/item", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch { res = null; }
    if (!res) { setMsg(OFFLINE); enable(true); return; }
    if (!res.ok) {
      // the hub's own sentence, whole — it knows why better than we do.
      let j = null;
      try { j = await res.json(); } catch { /* not JSON: fall through */ }
      setMsg((j && typeof j.error === "string" && j.error) || OFFLINE);
      enable(true);
      return;
    }
  }
  // Every edit landed. The hub is rebuilding the recipe now (§5.1 step 3); the
  // board on screen is the old one, so wait for the new ETag rather than
  // reloading into the same pictures.
  setMsg("Updating the board…");
  const t0 = Date.now();
  const step = async () => {
    if (!sheet) return;
    let changed = false;
    try { changed = watcher ? await watcher.checkNow() : false; } catch { changed = false; }
    if (!sheet) return;
    if (changed) { location.reload(); return; }
    if (Date.now() - t0 >= WAIT_MS) {
      // Never leave a grown-up watching a spinner: the edit IS saved, and the
      // board picks it up on its own next poll.
      setMsg("The board will update by itself in a minute.");
      pollTimer = setTimeout(close, 2500);
      return;
    }
    pollTimer = setTimeout(step, POLL_MS);
  };
  pollTimer = setTimeout(step, POLL_MS);
}

// ---- mount -----------------------------------------------------------------

// mountEditSheet({root, watcher, categories}) — board.js calls this on the
// CLOTHING board only (recipe === "today"), beside the wardrobe watcher whose
// checkNow() this borrows. `categories` is the recipe root's own list; with
// none the sheet simply shows no chips and Fancy / Hide still work.
export function mountEditSheet(opts) {
  const o = opts || {};
  if (mounted) return null;
  mounted = true;
  watcher = o.watcher || null;
  categories = Array.isArray(o.categories) ? o.categories.filter((c) => c && c.id) : [];
  // capture on WINDOW: ahead of era-core/dwell.js's document-capture handlers
  // (see the header — this is the whole reason the tap-rescue stays quiet).
  window.addEventListener("pointerdown", onDown, true);
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    window.addEventListener(ev, onEnd, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  // the suite's seam, mirroring window.__boardTest / window.__lockTest: a test
  // needs the hold it must out-wait without restating 1600 anywhere of its own,
  // and a door into the sheet that does not depend on CDP.
  window.__editTest = Object.assign({}, OV, {
    holdMs: HOLD_MS,
    open(ids) {
      const key = Array.isArray(ids) ? ids.join(",") : String(ids || "");
      const el = document.querySelector('.board-area .tile[data-items="' + key + '"]');
      const btn = tileButton(el);
      if (!btn || !Array.isArray(btn.items) || !btn.items.length) return false;
      openSheet(btn.items);
      return true;
    },
    close,
  });
  return { close, isOpen: () => !!sheet };
}
