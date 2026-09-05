// board-partner.js — the grown-up's strip in the board header (T4.4).
//
// The board's design rules say the message bar carries the door and nothing
// else, and that the door is its ONLY dwell target. Dad's 9/4 amendment opens
// exactly one crack in the first half of that rule: grown-up controls may ride
// in the header as a touch/click strip — the same class of thing as the
// #wardrobeNote footer — because Settings is already too busy to hold "add the
// song we are singing right now". The second half is untouched: nothing here
// carries .dwell or a data-dwell-* attribute, so Ellie's gaze slides straight
// over it and only a finger or a mouse can open any of it. (The 9/3 revert
// 7e9012f -> d4a7556 removed a bar button that WAS gaze-reachable; that is the
// line, not the header itself.)
//
// The strip exists on the two boards a grown-up curates — ?recipe=songs and
// ?recipe=movies — and on no other. Her outfit board keeps its bare bar.
//
// NOTE on the spec's "visible only when a pointer is present": ERAgaze moves
// the REAL cursor, so a gaze hover and a mouse hover are the same pointermove
// to this page — there is nothing to test for. The protection that actually
// holds is the one above: no dwell target, so a parked gaze can never fire it.

// Timing, overridable by tests exactly like board.js's own dials.
const T = Object.assign(
  { addPollMs: 3000, addGiveUpMs: 6 * 60 * 1000 },
  window.__boardTest || {},
);

const isLink = (s) => /^https?:\/\//i.test(s);

// One sheet at a time, owned by this module: it is created on the tap that
// needs it and removed on close, so the board she uses is never carrying a
// hidden overlay that could sit on top of a dwell target.
let sheet = null;
let pollTimer = null;
let seenWhen = null;   // /music/add/status's `last.when` as it was BEFORE this add

function onKey(e) { if (e.key === "Escape") closeSheet(); }

function closeSheet() {
  clearTimeout(pollTimer); pollTimer = null;
  document.removeEventListener("keydown", onKey, true);
  if (sheet) { sheet.remove(); sheet = null; }
}

// The sheet's one line of news. Everything a parent reads here comes from the
// hub (music-add.js writes the refusals in plain words) or from the two
// sentences below — never a status code, never a command line.
function say(text) {
  const el = sheet && sheet.querySelector("#sheetSay");
  if (el) el.textContent = text;
}

// After the 202 the download runs behind the door, so the sheet follows
// /music/add/status until the song lands or fails. `seenWhen` keeps a PREVIOUS
// add's result from being reported as this one's.
function watchAdd() {
  const until = Date.now() + T.addGiveUpMs;
  const tick = async () => {
    if (!sheet) return;
    let st = null;
    try { st = await (await fetch("/music/add/status", { cache: "no-store" })).json(); }
    catch { /* a blip: keep waiting, the download is on the hub, not here */ }
    if (!sheet) return;
    if (st && st.running) {
      const who = st.running.title ? "“" + st.running.title + "”" : "that song";
      say("New ERA is fetching " + who + " — " + st.running.phase + ".");
    } else if (st && st.last && st.last.when !== seenWhen) {
      if (st.last.ok) say((st.last.title || "That song") + " is on the board.");
      else say("New ERA could not add that song. " + (st.last.error || ""));
      return;                       // the answer is in: stop polling
    }
    if (Date.now() < until) pollTimer = setTimeout(tick, T.addPollMs);
  };
  clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, T.addPollMs);
}

// POST /music/add. A pasted address goes as {url}; anything else goes as
// {query} and the hub takes the first hit. JSON content-type is load-bearing:
// server.js's ownDoor() refuses anything else, because this door downloads from
// the internet onto the family's PC.
async function sendSong(raw, goBtn) {
  const body = isLink(raw) ? { url: raw } : { query: raw };
  goBtn.disabled = true;
  say("Sending that to New ERA…");
  let res, out = {};
  try {
    res = await fetch("/music/add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    goBtn.disabled = false;
    say("New ERA is not answering. Check that the hub is running, then try again.");
    return;
  }
  try { out = await res.json(); } catch { /* an answer with no body: say the plain thing */ }
  goBtn.disabled = false;
  if (!res.ok) {
    // 409 pack-missing / needs-local-drive / busy, 400 bad-url — every one of
    // them already carries a sentence a parent can act on. Show it as it is.
    say(out.message || "New ERA could not add that song.");
    return;
  }
  say("New ERA is fetching that song. It will be on the board in a minute.");
  watchAdd();
}

// The sheet. Pointer-only, like the strip that opens it: no .dwell anywhere,
// Escape and Close both dismiss it, and it is removed from the DOM on close.
function openSheet(kind) {
  if (sheet) return sheet;
  const wrap = document.createElement("div");
  wrap.id = "partnerSheet";
  const card = document.createElement("div");
  card.className = "sheet-card";
  const h = document.createElement("h2");
  h.textContent = kind === "songs" ? "Add a song"
                : kind === "movies" ? "Add a movie" : "Arrange the board";
  const hint = document.createElement("p");
  hint.className = "sheet-hint";
  card.append(h, hint);

  let input = null, goBtn = null;
  if (kind === "songs") {
    hint.textContent = "Paste a link to the song, or type its name and New ERA takes the first hit.";
    input = document.createElement("input");
    input.type = "text"; input.id = "sheetInput";
    input.setAttribute("autocomplete", "off");
    input.placeholder = "https://…  or  twinkle twinkle";
    card.appendChild(input);
  } else if (kind === "movies") {
    // Movies are Phase 5 (T5.4 wires this same sheet to the catalog writer).
    // Until then the strip says so rather than pretending to work.
    hint.textContent = "New ERA cannot add a movie from the board yet — that arrives with the movies work. Songs can be added from the Songs board today.";
  } else {
    // ⇅ Arrange with nobody owning arrange mode yet (T4.5).
    hint.textContent = "Moving the tiles around is not ready yet.";
  }

  const row = document.createElement("div");
  row.className = "sheet-row";
  if (kind === "songs") {
    goBtn = document.createElement("button");
    goBtn.type = "button"; goBtn.id = "sheetGo"; goBtn.className = "sheet-btn go";
    goBtn.textContent = "Add it";
    row.appendChild(goBtn);
  }
  const closeBtn = document.createElement("button");
  closeBtn.type = "button"; closeBtn.id = "sheetClose"; closeBtn.className = "sheet-btn";
  closeBtn.textContent = "Close";
  row.appendChild(closeBtn);
  const said = document.createElement("div");
  said.id = "sheetSay"; said.className = "sheet-say";
  card.append(row, said);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  sheet = wrap;

  closeBtn.addEventListener("click", closeSheet);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeSheet(); });
  // Escape on the DOCUMENT, not the card: the movies/arrange sheets hold no
  // input, so focus is still on the strip button that opened them.
  document.addEventListener("keydown", onKey, true);
  if (kind === "songs") {
    const submit = () => {
      const raw = input.value.trim();
      // The hub's own words for an empty add, said here so the round trip is
      // not spent on a blank box.
      if (!raw) { say("Paste a link to the song, or type its name."); return; }
      sendSong(raw, goBtn);
    };
    goBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    // What the shelf already knows, so a result left over from an earlier add
    // is never reported as this one's.
    seenWhen = null;
    fetch("/music/add/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((st) => { seenWhen = st && st.last ? st.last.when : null; })
      .catch(() => {});
    try { input.focus(); } catch { /* a kiosk with no keyboard focus: harmless */ }
  }
  return wrap;
}

// mountPartnerStrip({bar, recipe}) -> the strip, or null on a board that has
// none. The bar is board-render's .msgbar; the strip sits at the end opposite
// the door (the door owns the top-left corner — the easiest reach on screen).
export function mountPartnerStrip({ bar, recipe }) {
  const kind = recipe === "songs" ? "songs" : recipe === "movies" ? "movies" : null;
  if (!bar || !kind) return null;
  const strip = document.createElement("div");
  strip.id = "partnerStrip";
  const mk = (id, text) => {
    const b = document.createElement("button");
    b.type = "button"; b.id = id; b.className = "stripbtn";
    b.textContent = text;
    return b;                        // deliberately NO .dwell, NO data-dwell-*
  };
  const addBtn = mk("stripAdd", "+ Add");
  const arrangeBtn = mk("stripArrange", "⇅ Arrange");
  strip.append(addBtn, arrangeBtn);
  bar.appendChild(strip);

  addBtn.addEventListener("click", () => openSheet(kind));
  // ⇅ Arrange is T4.5 (drag the tiles, POST /music/order). It announces itself
  // on window and whoever owns arrange mode claims the tap with
  // preventDefault(); unclaimed, the strip says so instead of doing nothing.
  arrangeBtn.addEventListener("click", () => {
    const ev = new CustomEvent("board:arrange", { cancelable: true, detail: { recipe: kind } });
    const claimed = !window.dispatchEvent(ev);
    if (!claimed) openSheet("arrange");
  });
  return { strip, addBtn, arrangeBtn, openSheet: () => openSheet(kind), closeSheet };
}
