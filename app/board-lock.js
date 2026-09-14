// board-lock.js — the media lock (T3/T4, spec 2026-09-14).
//
// Dad 9/14: "in class, or when he is poking the tablet, I want to stop the music
// and the movies with one button." One 🔒 in the grown-up's header strip, held
// with a finger, stops the music and puts the song/movie tiles to sleep for a
// while — or until a grown-up holds it again.
//
// THIS IS DETERRENCE, NOT SECURITY (dad 9/14). It is FINE that a second device
// is not locked, that clearing the browser profile clears it, and that the
// passcode is a hash on the same machine as the lock it guards. The passcode
// exists for exactly one reason: the boy watched us do it and can copy a hold.
// Nothing here writes to the hub, and nothing here is asked to survive an
// adversary — only a sibling with a good memory.
//
// WHAT LOCKED MEANS: "reachable but inert". The board still renders, the nav
// doors still navigate, "More" still turns the page and the DOOR still leaves —
// the way out is never taken away from her, not for a grown-up's sheet
// (board-partner.js), not for arrange mode (board-arrange.js), and not for
// this. Only the tiles that would make a NOISE go quiet.
//
// WHY THIS OWNS ITS OWN FROZEN LIST. board-partner.js's freezeBoard/thawBoard
// share one module-level `frozen` array scoped to the partner sheet, and
// arrange mode has a third. Three switches over one list would mean the last
// one to close wakes everything the other two put to sleep — so each keeps
// only what IT disarmed, and hands back only that. Locking under an open sheet
// and closing the sheet leaves the songs asleep, which is the whole point.
//
// WHY THE HOLD IS HAND-ROLLED. The button carries no .dwell and no
// data-dwell-* attribute — the 9/4 amendment lets grown-up controls ride in the
// header ONLY as a touch/click strip, and #barDoor stays the bar's one dwell
// target. That also means era-core/dwell.js's long-press TAP-RESCUE and its
// contextmenu preventDefault never see this button (both filter on
// `.closest(".dwell")`), so the press timer and the right-click suppression are
// written out here. Windows turns a long press into the press-and-hold
// right-click gesture at ~600 ms; without the preventDefault pair a 1600 ms
// finger would pop a context menu over the board instead of locking it.
//
// AND WHY TOUCH ONLY. ERAgaze moves the REAL cursor, so at the DOM level a
// parked gaze and a parked mouse are the same pointer. A hold that answered
// `mouse` would be a hold she could fire by looking at it — which is precisely
// the thing the amendment forbids. `pointerType === "touch"` is the whole
// filter; a grown-up uses a finger, and on a mouse-only bench nothing here is
// reachable at all (by design — Settings is where the minutes and the passcode
// live).

import { CONTRACT as EC } from "../lib/contract.js";

const KEY = "era.lock";
// The hold is the contract's nav-DOOR floor, not a number invented here: this
// is a deliberate commitment on a kiosk, the same class of act as walking
// through a door (whitelist principle, ux-contract §C).
const HOLD_MS = EC.holds.navMin;
// The tiles that make a noise. `show` is NOT here: it is a nav door to an
// episode page, and navigating is never what the lock is for.
const MEDIA_TYPES = new Set(["song", "full", "stop", "movie", "episode"]);

// ---- the stored fact -------------------------------------------------------
// { until: <epoch ms> }, where until 0 means "until a grown-up unlocks it".
// Absent, unparseable, or a time already past = unlocked. An expired key is
// CLEARED as it is read rather than left to rot: the next board to open should
// find the truth, not a fossil it has to re-reason about.

export function readLock() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { return null; }   // private mode / blocked
  if (!raw) return null;
  let v = null;
  try { v = JSON.parse(raw); } catch { clearLock(); return null; }
  if (!v || typeof v.until !== "number" || !isFinite(v.until)) { clearLock(); return null; }
  if (v.until !== 0 && v.until <= Date.now()) { clearLock(); return null; }
  return { until: v.until };
}

export function writeLock(until) {
  // Math.round, NEVER `| 0`: an epoch in milliseconds is ~1.8e12 and a bitwise
  // OR truncates it to 32 bits, which is how the first cut wrote a lock that
  // expired in 1970 and vanished on the very next read.
  const n = Math.round(Number(until));
  try { localStorage.setItem(KEY, JSON.stringify({ until: isFinite(n) ? n : 0 })); }
  catch { /* private mode / storage blocked: the lock is best-effort by design */ }
}

export function clearLock() {
  try { localStorage.removeItem(KEY); } catch { /* best effort */ }
}

export function isLocked() { return readLock() != null; }

// ---- the locked state on THIS page ----------------------------------------

let disarmed = [];        // the tiles THIS lock put to sleep, and only those
let expiryTimer = null;
let btn = null;           // the 🔒 in the strip, once one is mounted
let warn = null;          // #lockWarn, created on first need
let music = null;         // the player board.js handed over (null on the splash)
let cfg = { lockMinutes: 45, lockPasscodeHash: "" };

const player = () => music || window.Music || null;

// Take the media tiles out of gaze's reach. BOTH the class and the attribute,
// for the two different things they stop in era-core/dwell.js: the attribute is
// what targetAt() honours (so a parked gaze can never fill), and dropping the
// CLASS is what stops the 150 ms long-press tap-rescue, whose pointerdown
// remembers `closest(".dwell")` with no such filter. Arrange mode learned this
// first; the partner sheet learned it second (review 9/5).
//
// Idempotent, and safe to call after any render: a tile already in the list is
// not added twice, and #barDoor is never a candidate in the first place (it is
// not a .tile and carries no tileType).
function applyLock() {
  for (const el of document.querySelectorAll(".board-area .tile[data-tile-type]")) {
    if (!MEDIA_TYPES.has(el.dataset.tileType)) continue;
    if (!el.classList.contains("dwell")) continue;
    el.classList.remove("dwell");
    el.setAttribute("data-dwell-disabled", "");
    disarmed.push(el);
  }
}

function releaseLock() {
  for (const el of disarmed) {
    if (!el.isConnected) continue;             // it went with a re-render: nothing to wake
    el.classList.add("dwell");
    el.removeAttribute("data-dwell-disabled");
  }
  disarmed = [];
  // A finger (or a gaze) may be parked on a tile as the lock lifts: give the
  // board a settle window so it does not inherit a hold nobody started — the
  // same courtesy arrange mode and the partner sheet pay on the way out.
  try { if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(600); } catch { /* bare page */ }
}

// The banner. Style and manners of #launchWarn: touch only, never .dwell, and
// pointer-events:none so a tap on it reaches whatever is underneath. Unlike
// #launchWarn it has no timer — it stands for as long as the lock does, because
// a grown-up walking up to a silent board should be able to read WHY.
function setWarn(until) {
  if (!warn) {
    warn = document.getElementById("lockWarn");
    if (!warn) {
      warn = document.createElement("div");
      warn.id = "lockWarn";
      document.body.appendChild(warn);
    }
  }
  if (until == null) { warn.classList.remove("show"); return; }
  warn.textContent = until === 0 ? "Locked"
    : "Locked until " + new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  warn.classList.add("show");
}

// The one place that makes the page agree with the stored fact. Everything that
// can change the lock — the hold, the keypad, a sibling tab's `storage` event,
// the expiry timer — ends here rather than half-applying its own version.
function applyState() {
  const lock = readLock();
  clearTimeout(expiryTimer); expiryTimer = null;
  if (btn) btn.classList.toggle("locked", !!lock);
  if (!lock) { releaseLock(); setWarn(null); return; }
  applyLock();
  setWarn(lock.until);
  // Expiry thaws IN PLACE (no reload): the board she is looking at simply wakes
  // up. setTimeout is capped near 24.8 days and lockMinutes is clamped to 1440
  // in the hub, so the delay can never overflow into "fires immediately".
  if (lock.until !== 0) expiryTimer = setTimeout(applyState, Math.max(0, lock.until - Date.now()) + 50);
}

// Re-arm after a render. board-render.js calls this at the tail of render(),
// where applyPlaying/applyWatching already re-apply the other two markers that
// have to survive a page turn: a rebuilt grid is fresh DOM that has never seen
// applyLock, so without this "More" would hand a locked board a live page.
export function syncLock() {
  if (!readLock()) return;
  disarmed = disarmed.filter((el) => el.isConnected);   // the old page's nodes are gone
  applyLock();
}

// ---- the keypad (T4) -------------------------------------------------------
// A grown-up surface behind a hold, so touch and click are both fine here — but
// it is on HER screen, so nothing in it may be a gaze target and every key is a
// >=90 px box (invariants law 1). The digits never leave this function: what is
// compared is SHA-256 of the entry against the hash Settings stored.

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const KEYPAD_ROWS = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["del", "0", "ok"]];
const KEY_FACE = { del: "⌫", ok: "✓", cancel: "Cancel" };

function openKeypad({ hash, onOk }) {
  if (document.getElementById("lockPad")) return;
  let entry = "";
  const pad = document.createElement("div");
  pad.id = "lockPad";
  const card = document.createElement("div");
  card.className = "lockpad-card";
  const title = document.createElement("div");
  title.className = "lockpad-title";
  title.textContent = "Grown-up passcode";
  const dots = document.createElement("div");
  dots.className = "lockpad-dots";
  // Masked, and masked from the start: a passcode typed in a classroom is typed
  // in front of whoever asked about it.
  for (let i = 0; i < 6; i++) {
    const d = document.createElement("span");
    d.className = "lockpad-dot";
    dots.append(d);
  }
  const paint = () => {
    [...dots.children].forEach((d, i) => d.classList.toggle("on", i < entry.length));
  };
  const grid = document.createElement("div");
  grid.className = "lockpad-grid";

  const close = () => { pad.remove(); };

  async function submit() {
    // An empty entry is a mis-tap, not a wrong passcode: say nothing and wait.
    if (!entry) return;
    let got = "";
    try { got = await sha256Hex(entry); } catch { got = ""; }
    if (got && got === hash) { close(); onOk(); return; }
    // Wrong. Shake, clear, STAY — no counter, no lockout: the spec's non-goals
    // say so plainly, and a grown-up who fat-fingers 2468 at the back of a
    // classroom should just be able to try again.
    card.classList.remove("shake");
    void card.offsetWidth;                     // restart the animation
    card.classList.add("shake");
    entry = ""; paint();
  }

  const key = (k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lockpad-key" + (k === "ok" ? " ok" : "");
    b.dataset.key = k;                         // deliberately NO .dwell, NO data-dwell-*
    b.textContent = KEY_FACE[k] || k;
    b.addEventListener("click", () => {
      if (k === "cancel") { close(); return; }
      if (k === "del") { entry = entry.slice(0, -1); paint(); return; }
      if (k === "ok") { submit(); return; }
      if (entry.length >= 6) return;
      entry += k; paint();
      // Six digits is the longest a passcode may be (Settings clamps 4-6), so
      // the sixth digit IS the ✓ — one fewer tap on the way back to the music.
      if (entry.length === 6) submit();
    });
    return b;
  };
  for (const row of KEYPAD_ROWS) for (const k of row) grid.append(key(k));
  const foot = document.createElement("div");
  foot.className = "lockpad-foot";
  foot.append(key("cancel"));
  card.append(title, dots, grid, foot);
  pad.append(card);
  // An outside tap closes it and leaves the board LOCKED: giving up is not a
  // way in. Same manners as the partner sheet's backdrop — but on POINTERDOWN,
  // not click, and that is load-bearing: this pad is opened by a finger that is
  // still DOWN on the 🔒 when it appears, and the release of that same press
  // sends a click at those coordinates into whatever is now underneath — which
  // is this full-screen backdrop. On `click` the pad shut itself the instant
  // the grown-up lifted their finger, every single time. A pointerdown belongs
  // to a press that STARTED on the backdrop, so the opening gesture cannot
  // dismiss the thing it just opened.
  pad.addEventListener("pointerdown", (e) => { if (e.target === pad) close(); });
  document.body.appendChild(pad);
  paint();
}

// ---- the button ------------------------------------------------------------

// mountLockButton({strip, mk, settings, music}) — appends the 🔒 to the
// grown-up's strip. `mk` is board-partner.js's own button factory, reused so
// this button can never drift away from "+ Add" in class or in what it
// deliberately lacks. `music` may be null (the splash has no player); the
// window hook is the fallback for a board that made one after the strip mounted.
export function mountLockButton({ strip, mk, settings, music: m }) {
  if (!strip || !mk) return null;
  music = m || null;
  if (settings) {
    const n = Number(settings.lockMinutes);
    if (isFinite(n) && n >= 0) cfg.lockMinutes = Math.round(n);
    if (typeof settings.lockPasscodeHash === "string") cfg.lockPasscodeHash = settings.lockPasscodeHash;
  }
  btn = mk("stripLock", "🔒");
  btn.classList.add("lock");
  btn.setAttribute("aria-label", "lock");
  // The fill ring runs on the CSS side off this one custom property, so the
  // hold length is stated once, here, from the contract.
  btn.style.setProperty("--hold-ms", HOLD_MS + "ms");
  strip.append(btn);

  let timer = null;
  const stopHold = () => {
    clearTimeout(timer); timer = null;
    btn.classList.remove("holding");
  };
  btn.addEventListener("pointerdown", (e) => {
    // Mouse and pen do nothing — see the header: gaze IS the mouse here.
    if (e.pointerType !== "touch") return;
    // Both halves of the Windows long-press gesture have to be refused: this
    // stops the compatibility mouse events (and so the click), and the
    // contextmenu handler below stops the menu the press-and-hold would pop.
    e.preventDefault();
    stopHold();
    btn.classList.add("holding");
    timer = setTimeout(() => { stopHold(); fire(); }, HOLD_MS);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    btn.addEventListener(ev, stopHold);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());

  function fire() {
    if (isLocked()) {
      // The way out. No passcode = the hold IS the unlock; a passcode set means
      // a grown-up decided the hold alone is something the boy can copy.
      if (!cfg.lockPasscodeHash) { clearLock(); applyState(); return; }
      openKeypad({ hash: cfg.lockPasscodeHash, onOk: () => { clearLock(); applyState(); } });
      return;
    }
    writeLock(cfg.lockMinutes ? Date.now() + cfg.lockMinutes * 60000 : 0);
    // Stop what is playing FIRST-class: the whole point of the press is that
    // the room goes quiet, and disarming the tiles alone would leave the song
    // that is already running to finish.
    const p = player();
    try { if (p && p.stop) p.stop(); } catch { /* a player mid-teardown is not a reason to fail the lock */ }
    applyState();
  }

  // Same origin, so the songs board, the movies board and the splash are all
  // looking at one fact: a lock set in another tab reaches this one with no
  // polling at all. (key === null is a localStorage.clear() somewhere.)
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key == null) applyState();
  });

  applyState();     // a lock written before this board opened is honoured on load
  return btn;
}

// The suite's seam, mirroring window.__boardTest / window.__musicTest: a test
// needs to be able to write the stored fact and to know the hold it must
// out-wait without restating 1600 anywhere of its own.
window.__lockTest = { readLock, writeLock, clearLock, holdMs: HOLD_MS };
