// board-arrange.js — "⇅ Arrange": a grown-up moves the songs with a finger (T4.5).
//
// The strip (board-partner.js, T4.4) fires a cancelable `board:arrange` on
// window; claiming it with preventDefault() is how this module says "I own
// arrange mode on this board". Unclaimed — the movies board today — the strip
// says so instead of pretending to work. T5.4 claims it for movies.
//
// WHAT ARRANGE MODE COSTS THE BOARD, and why it is written this way:
//
//   1. While a parent is dragging, a tile is furniture, not a door. Every tile
//      loses .dwell AND gains data-dwell-disabled. Both, deliberately, because
//      they stop two different things in era-core/dwell.js:
//        * data-dwell-disabled is what the GAZE path honours (dwell.js's
//          targetAt() looks for ".dwell:not([data-dwell-disabled])"), so a gaze
//          parked on the song being dragged can never fill and fire;
//        * dropping the CLASS is what stops the 150ms long-press TAP-RESCUE —
//          dwell.js's pointerdown remembers `closest(".dwell")` with no such
//          filter, and its pointerup synthesizes the click Windows owed us.
//          At the end of a drag that click would open the song that just moved.
//      Neither needs a change in era-core: dwell.js is shared by every app in
//      the suite, and this task is not allowed to touch it.
//   2. board-render's onTile() checks api.isArranging() first, so even a click
//      already in flight when the mode opened cannot pick a song.
//   3. The door keeps its dwell throughout. The way out of the board is never
//      taken away from her, not even for a minute of grown-up housekeeping.
//
// The move itself is a SWAP, not an insert, because the songs board's cells are
// fixed (server.js SONG_CELLS_P1 skips the black centre pair, which is board
// design law): a song lives in a cell, and arranging is exchanging two of them.
// The swap is applied to the loaded recipe's buttons, so a re-render — a resize,
// say — keeps what the parent just did instead of snapping back.
//
// The hub is then told the WHOLE running order, every page of it, because
// music-add.js's order() refuses a partial list rather than half-apply one.
// A refusal is undone on screen and shown in the hub's own words.

// Where each board's order goes. Movies arrive in T5.4 with their own writer.
const ENDPOINT = { songs: "/music/order" };

const cellOf = (b) => ({ r: b.row || 1, c: b.col || 1 });

// The tiles a drag may move on one board: the grid's song DOORS, in the order
// the hub laid them out (row-major, matching SONG_CELLS_P1 and therefore rank).
// The hero on a song's own page has the same song_id and no `load`; it is not a
// place in the running order and is never moved.
function movables(board) {
  return (board && board.buttons ? board.buttons : [])
    .filter((b) => b && (b.type || "").toLowerCase() === "song" && b.song_id && b.load != null)
    .sort((a, b) => (cellOf(a).r - cellOf(b).r) || (cellOf(a).c - cellOf(b).c));
}

export function mountArrange({ api, partner, recipe }) {
  const endpoint = ENDPOINT[recipe];
  if (!api || !endpoint) return null;          // not a board anyone arranges yet

  const btn = partner && partner.arrangeBtn ? partner.arrangeBtn : null;
  const btnLabel = btn ? btn.textContent : "";
  let on = false, note = null, drag = null, watcher = null;

  // ---- the one line of news, in a pill under the board. Pointer-events:none
  // in the stylesheet: it must never eat the end of a drag.
  function say(text) { if (note) note.textContent = text; }

  // ---- freeze / thaw (see the header — this is the whole dwell story) -------
  function freeze() {
    for (const el of api.area.querySelectorAll(".tile")) {
      el.classList.remove("dwell");
      el.setAttribute("data-dwell-disabled", "");
    }
  }
  function thaw() {
    for (const el of api.area.querySelectorAll(".tile")) {
      el.classList.add("dwell");
      el.removeAttribute("data-dwell-disabled");
    }
    // the pointer may be parked on a tile as the mode closes: give the board a
    // settle window so it does not inherit a hold nobody started.
    try { if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(600); } catch { /* dwell.js absent in a bare page */ }
  }

  // ---- the move ------------------------------------------------------------
  // Exchange two songs' cells in the loaded recipe, then redraw. Returns false
  // if either id is not on the board any more (a recipe reload mid-drag).
  function swap(idA, idB) {
    const board = api.session.current;
    const a = movables(board).find((b) => b.song_id === idA);
    const b = movables(board).find((x) => x.song_id === idB);
    if (!a || !b || a === b) return false;
    const r = a.row, c = a.col;
    a.row = b.row; a.col = b.col;
    b.row = r; b.col = c;
    api.render();
    freeze();                                  // the redraw handed back fresh tiles
    return true;
  }

  // Every song the board knows, page after page, in the order it now shows
  // them — the only shape the hub accepts.
  function runningOrder() {
    const ids = [];
    for (const board of api.session.model.boards.values())
      for (const b of movables(board)) ids.push(b.song_id);
    return ids;
  }

  async function save(idA, idB) {
    const ids = runningOrder();
    say("Saving the new order…");
    let res, out = {};
    try {
      res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    } catch {
      swap(idB, idA);                          // nothing was saved: show the truth
      say("New ERA is not answering. Check that the hub is running, then try again.");
      done(false);
      return;
    }
    try { out = await res.json(); } catch { /* an answer with no body */ }
    if (!res.ok) {
      // The hub already writes its refusals in words a parent can act on
      // (music-add.js): show it, and put the tiles back where they were so the
      // board on screen and the board on disk never disagree.
      swap(idB, idA);
      say(out.message || "New ERA could not save that order.");
      done(false);
      return;
    }
    say("The songs are in their new order.");
    done(true);
  }
  // Whoever is watching — a test, a future partner console — hears the answer.
  function done(ok) {
    try { window.dispatchEvent(new CustomEvent("board:arranged", { detail: { ok } })); } catch {}
  }

  // ---- the drag ------------------------------------------------------------
  // Pointer events, not HTML5 drag-and-drop: this runs under a finger on a
  // kiosk panel. preventDefault() on pointerdown is load-bearing twice over —
  // it stops the compatibility mouse events (so no click is generated at all)
  // and it stops the panel treating the drag as a pan.
  function under(x, y) {
    if (!drag) return null;
    const was = drag.el.style.pointerEvents;
    drag.el.style.pointerEvents = "none";      // look THROUGH the tile in hand
    const hit = document.elementFromPoint(x, y);
    drag.el.style.pointerEvents = was;
    return hit && hit.closest ? hit.closest(".tile[data-arrange-id]") : null;
  }

  function onDown(e) {
    if (!on || drag) return;
    const el = e.target && e.target.closest ? e.target.closest(".tile[data-arrange-id]") : null;
    if (!el) return;
    e.preventDefault();
    drag = { id: el.dataset.arrangeId, el, x0: e.clientX, y0: e.clientY, over: null, pid: e.pointerId };
    el.classList.add("dragging");
    try { el.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    e.preventDefault();
    drag.el.style.transform = "translate(" + (e.clientX - drag.x0) + "px," + (e.clientY - drag.y0) + "px)";
    const over = under(e.clientX, e.clientY);
    const next = over && over !== drag.el ? over : null;
    if (next !== drag.over) {
      if (drag.over) drag.over.classList.remove("drop-target");
      drag.over = next;
      if (drag.over) drag.over.classList.add("drop-target");
    }
  }

  function endDrag(keep) {
    if (!drag) return null;
    const d = drag; drag = null;
    d.el.style.transform = "";
    d.el.classList.remove("dragging");
    if (d.over) d.over.classList.remove("drop-target");
    return keep && d.over ? { from: d.id, to: d.over.dataset.arrangeId } : null;
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const move = endDrag(true);
    if (!move || move.from === move.to) return;
    if (swap(move.from, move.to)) save(move.from, move.to);
  }
  function onCancel() { endDrag(false); }

  // ---- the mode ------------------------------------------------------------
  function enter() {
    if (on) return;
    on = true;
    api.setArranging(true);
    api.area.classList.add("arranging");
    freeze();
    // A render this module did not ask for (a resize) hands back fresh, live
    // tiles — put them back to sleep the moment they appear.
    try {
      watcher = new MutationObserver(() => { if (on) freeze(); });
      watcher.observe(api.area, { childList: true });
    } catch { /* no MutationObserver: the resize case simply re-arms dwell */ }
    note = document.createElement("div");
    note.id = "arrangeNote";
    note.textContent = "Drag a song onto another to swap them. Tap ✓ Done when the board looks right.";
    document.body.appendChild(note);
    api.area.addEventListener("pointerdown", onDown);
    api.area.addEventListener("pointermove", onMove);
    api.area.addEventListener("pointerup", onUp);
    api.area.addEventListener("pointercancel", onCancel);
    if (btn) btn.textContent = "✓ Done";
  }

  function exit() {
    if (!on) return;
    on = false;
    endDrag(false);
    api.area.removeEventListener("pointerdown", onDown);
    api.area.removeEventListener("pointermove", onMove);
    api.area.removeEventListener("pointerup", onUp);
    api.area.removeEventListener("pointercancel", onCancel);
    if (watcher) { watcher.disconnect(); watcher = null; }
    api.area.classList.remove("arranging");
    thaw();
    api.setArranging(false);
    if (note) { note.remove(); note = null; }
    if (btn) btn.textContent = btnLabel;
  }

  // The strip's tap. Claiming the event (preventDefault) is what tells
  // board-partner.js that arrange mode has an owner on this board.
  function onStrip(e) {
    e.preventDefault();
    if (on) exit(); else enter();
  }
  window.addEventListener("board:arrange", onStrip);

  return { enter, exit, isOn: () => on, runningOrder };
}
