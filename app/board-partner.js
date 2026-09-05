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
// The same rule reaches DOWN, not just across: while the sheet is open the
// board beneath it is put to sleep, because a full-screen backdrop hides
// nothing from dwell.js (see freezeBoard below). The door keeps its dwell
// throughout — that one is never taken away from her.
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
let frozen = [];       // the dwell targets this sheet put to sleep

function onKey(e) { if (e.key === "Escape") closeSheet(); }

// While the sheet is up, the board underneath is furniture — and a backdrop is
// NOT what makes it one. era-core/dwell.js's targetAt() walks the WHOLE
// elementsFromPoint stack looking for the first
// `.dwell:not([data-dwell-disabled])`, so a full-screen overlay with no .dwell
// is simply stepped over: while a grown-up typed into this sheet, a parked gaze
// could still fire the song tiles behind it (review 9/5). Arrange mode learned
// this first — board-arrange.js freeze() — and for the same reason takes BOTH
// the class and the attribute: the attribute stops the gaze fill, dropping the
// class stops dwell.js's 150 ms long-press tap-rescue.
//
// The door keeps its dwell. The way out of the board is never taken away from
// her, not even for a grown-up's sheet. And only what THIS sheet put to sleep
// is woken again, so opening a sheet while arrange mode is on hands the board
// back exactly as arrange mode left it.
function freezeBoard(except) {
  frozen = [...document.querySelectorAll(".dwell")]
    .filter((el) => el.id !== "barDoor" && !except.contains(el));
  for (const el of frozen) {
    el.classList.remove("dwell");
    el.setAttribute("data-dwell-disabled", "");
  }
}
function thawBoard() {
  for (const el of frozen) {
    el.classList.add("dwell");
    el.removeAttribute("data-dwell-disabled");
  }
  frozen = [];
  // the pointer may be parked on a tile as the sheet closes: give the board a
  // settle window so it does not inherit a hold nobody started.
  try { if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(600); } catch { /* dwell.js absent in a bare page */ }
}

function closeSheet() {
  clearTimeout(pollTimer); pollTimer = null;
  document.removeEventListener("keydown", onKey, true);
  results = null;                     // it went with the card
  if (sheet) { sheet.remove(); sheet = null; }
  thawBoard();
}

// The sheet's one line of news. Everything a parent reads here comes from the
// hub (music-add.js writes the refusals in plain words) or from the two
// sentences below — never a status code, never a command line.
function say(text) {
  const el = sheet && sheet.querySelector("#sheetSay");
  if (el) el.textContent = text;
}

// The search grid, when one is up. Torn down by the pick that ends it and by
// the next search — a sheet never holds two answers at once.
let results = null;
function clearResults() {
  if (results) { results.remove(); results = null; }
  const credit = sheet && sheet.querySelector("#sheetCredit");
  if (credit) credit.remove();
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
      // `mirrored:false` = the song is in the family's folder but this device's
      // shelf has not taken it yet, so the tile is not there to look at.
      if (st.last.ok) say((st.last.title || "That song") + " is on the board."
        + (st.last.mirrored === false ? " The board will catch up in a few minutes." : ""));
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
    // 409 pack-missing / needs-local-drive / busy / manifest-unreadable, 400
    // bad-url — every one of them already carries a sentence a parent can act
    // on. Show it as it is.
    say(out.message || "New ERA could not add that song.");
    // ...and "install it and try again" gets something to press.
    if (out.error === "pack-missing" && out.pack) offerInstall(out.pack, goBtn);
    return;
  }
  say("New ERA is fetching that song. It will be on the board in a minute.");
  watchAdd();
}

// The pack the hub named, fetched on one press. music-add.js hands back the
// pack id with "pack-missing" for exactly this, and POST /packs/install is the
// hub's door for a pack no app owns — media-tools is unticked in the installer
// by default, so without this the sheet's "Install it and try again" pointed at
// a button that existed nowhere on the machine (review 9/5).
function offerInstall(pack, goBtn) {
  if (!sheet || sheet.querySelector("#sheetInstall")) return;
  const b = document.createElement("button");
  b.type = "button"; b.id = "sheetInstall"; b.className = "sheet-btn go";
  b.textContent = "Install it now";              // deliberately NO .dwell
  const row = sheet.querySelector(".sheet-row");
  row.insertBefore(b, row.firstChild);
  b.addEventListener("click", async () => {
    b.disabled = true;
    if (goBtn) goBtn.disabled = true;            // adding cannot work until it lands
    say("New ERA is getting the downloader. This takes a minute.");
    let res;
    try {
      res = await fetch("/packs/install", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack }),
      });
    } catch {
      b.disabled = false; if (goBtn) goBtn.disabled = false;
      say("New ERA is not answering. Check that the hub is running, then try again.");
      return;
    }
    if (!res.ok) {
      b.disabled = false; if (goBtn) goBtn.disabled = false;
      say("New ERA could not start that download. Try again.");
      return;
    }
    watchPack(b, goBtn);
  });
}

// The download runs on the hub, so the sheet follows the status door it is
// already polling: /music/add/status says whether the pack is on disk.
function watchPack(btn, goBtn) {
  const until = Date.now() + T.addGiveUpMs;
  const tick = async () => {
    if (!sheet) return;
    let st = null;
    try { st = await (await fetch("/music/add/status", { cache: "no-store" })).json(); }
    catch { /* a blip: the download is on the hub, not here */ }
    if (!sheet) return;
    if (st && st.pack && st.pack.installed) {
      btn.remove();
      if (goBtn) goBtn.disabled = false;
      say("The downloader is ready. Press “Add it” to try that song again.");
      return;
    }
    if (Date.now() < until) { pollTimer = setTimeout(tick, T.addPollMs); return; }
    btn.disabled = false;
    if (goBtn) goBtn.disabled = false;
    say("That download is taking a long time. Try again later.");
  };
  clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, T.addPollMs);
}

// ------------------------------------------------------------------- movies
//
// The same sheet, the other half (T5.4). What makes movies different from
// songs is that a TYPED NAME IS NOT AN ADD: the hub looks it up
// (POST /movies/lookup, which writes nothing) and a grown-up picks the row
// they meant out of a grid. The first hit for "peter rabbit" is not the one a
// family means often enough to put on a six-year-old's board unasked, and the
// grid is also where the age rating and the service are read before anyone
// commits — that is the whole reason this is two steps and not one.
//
// A PASTED LINK skips all of it and goes straight to /movies/add, because the
// address a parent copied out of Netflix is the answer already.
//
// The hub never serves video (D57): nothing here downloads anything and
// nothing here touches the launch path. A film is a link the ERAgaze kiosk
// opens, and adding one only ever writes a line in the family's catalog.

// "on Netflix", "on Netflix · Disney+", or the plain truth. The row is worth
// showing even when nobody streams it here — a parent may still want it on the
// list, and the hub writes it pending rather than putting a dead tile up.
function whereText(hit) {
  const names = (Array.isArray(hit.providers) ? hit.providers : [])
    .map((p) => p && p.name).filter(Boolean);
  if (!names.length) return "not streaming here";
  return "on " + names.slice(0, 2).join(" · ") + (names.length > 2 ? " +" + (names.length - 2) : "");
}

// The picked row as /movies/add's body. Only what the search actually FOUND is
// sent: no link is invented for a title nobody could give one for (the hub
// writes that pending), and an empty providerRef is left out rather than
// stamping "we checked" on a check that found nothing.
function pickBody(hit) {
  const body = { title: hit.title, kind: hit.kind === "show" ? "show" : "movie" };
  const link = (Array.isArray(hit.providers) ? hit.providers : [])
    .map((p) => p && p.deepLink).find(Boolean);
  if (link) body.url = link;
  if (Number.isFinite(hit.year)) body.year = hit.year;
  if (Number.isFinite(hit.tmdbId)) body.tmdbId = hit.tmdbId;
  if (hit.ageRating) body.ageRating = hit.ageRating;
  if (hit.providerRef && typeof hit.providerRef === "object" &&
      !Array.isArray(hit.providerRef) && Object.keys(hit.providerRef).length)
    body.providerRef = hit.providerRef;
  body.addedBy = "search";                 // a pick is a search, however it is spelled
  return body;
}

// POST /movies/add. Unlike a song, this answers when it is DONE — one small
// file and a mirror of a folder the family already has locally — so the sheet
// reports the outcome instead of following a status door.
async function sendMovie(body, btn) {
  if (btn) btn.disabled = true;
  say("Sending that to New ERA…");
  let res, out = {};
  try {
    res = await fetch("/movies/add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    if (btn) btn.disabled = false;
    say("New ERA is not answering. Check that the hub is running, then try again.");
    return;
  }
  try { out = await res.json(); } catch { /* an answer with no body: say the plain thing */ }
  if (btn) btn.disabled = false;
  if (!res.ok) {
    // 400 bad-url / bad-id, 409 needs-local-drive / catalog-unreadable — every
    // one of them already carries a sentence a parent can act on.
    say(out.message || "New ERA could not add that film.");
    return;
  }
  clearResults();                          // the question is answered: one add per sheet
  const name = out.title || "That film";
  if (out.pending) {
    // The title is kept — a parent's list is not lost because nobody could
    // find a link — but it is NOT drawn, so say so rather than sending them to
    // look for a tile that is not there.
    say(name + " is saved, but New ERA has no link to play it yet. Open the app it streams on and paste the film's address here.");
    return;
  }
  // `mirrored:false` = the catalog is written in the family's folder but this
  // device's shelf has not taken it yet, so the tile is not there to look at.
  say(name + " is on the board."
      + (out.mirrored === false ? " The board will catch up in a few minutes." : ""));
}

// The grid itself. Every cell is a plain <button> with NO .dwell and no
// data-dwell-* attribute, exactly like the strip that opened the sheet: a gaze
// parked on a poster fills nothing and picks nothing.
function drawResults(rows, out) {
  const card = sheet.querySelector(".sheet-card");
  const before = sheet.querySelector("#sheetSay");
  const grid = document.createElement("div");
  grid.id = "sheetResults";
  rows.forEach((hit, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.id = "sheetPick" + i; b.className = "sheet-result";
    if (hit.poster) {
      const img = document.createElement("img");
      img.className = "sheet-poster"; img.src = hit.poster; img.alt = "";
      // art that will not load is not a broken row: drop the picture, keep the
      // name. The same rule the board's own poster-less tiles follow.
      img.addEventListener("error", () => img.remove());
      b.appendChild(img);
    }
    const t = document.createElement("span");
    t.className = "sheet-title"; t.textContent = hit.title || "";
    const y = document.createElement("span");
    y.className = "sheet-year"; y.textContent = Number.isFinite(hit.year) ? String(hit.year) : "";
    const w = document.createElement("span");
    w.className = "sheet-where"; w.textContent = whereText(hit);
    b.append(t, y, w);
    b.addEventListener("click", () => sendMovie(pickBody(hit), b));
    grid.appendChild(b);
  });
  card.insertBefore(grid, before);
  results = grid;
  // TMDB's terms want the credit wherever their art is shown, and the hub
  // sends the exact sentence so this file never owns a second copy of it.
  if (out && out.attribution) {
    const c = document.createElement("div");
    c.id = "sheetCredit"; c.className = "sheet-credit";
    c.textContent = out.attribution;
    card.insertBefore(c, before);
  }
}

// POST /movies/lookup. It WRITES NOTHING — an empty grid is a 200 with a hint,
// because a family with no key is not an error and neither is a provider
// having a bad day. Both roads end at the paste box that already works.
async function searchMovies(q, goBtn) {
  clearResults();
  goBtn.disabled = true;
  say("Looking for “" + q + "”…");
  let res, out = {};
  try {
    res = await fetch("/movies/lookup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
  } catch {
    goBtn.disabled = false;
    say("New ERA is not answering. Check that the hub is running, then try again.");
    return;
  }
  try { out = await res.json(); } catch { /* an answer with no body */ }
  goBtn.disabled = false;
  if (!sheet) return;                      // the parent closed it while we waited
  if (!res.ok) {
    say(out.message || "New ERA could not look that up. Paste the film's link instead.");
    return;
  }
  const rows = Array.isArray(out.results) ? out.results : [];
  if (!rows.length) {
    // out.hint is the hub's own sentence for "no key" and "no deep links": it
    // names Settings and it names the paste box.
    say(out.hint || "New ERA could not find anything called “" + q + "”. Paste the film's link instead.");
    return;
  }
  drawResults(rows, out);
  say(out.hint ? "Pick the one you mean. " + out.hint : "Pick the one you mean.");
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
  const asks = kind === "songs" || kind === "movies";
  if (asks) {
    hint.textContent = kind === "songs"
      ? "Paste a link to the song, or type its name and New ERA takes the first hit."
      // Movies do NOT take the first hit: a name is searched and a grown-up
      // picks the row, because the wrong "peter rabbit" on a child's board is
      // a worse outcome than one more tap.
      : "Paste a link to the film, or type its name and pick it from the list.";
    input = document.createElement("input");
    input.type = "text"; input.id = "sheetInput";
    input.setAttribute("autocomplete", "off");
    input.placeholder = kind === "songs" ? "https://…  or  twinkle twinkle"
                                         : "https://…  or  ada twist";
    card.appendChild(input);
  } else {
    // ⇅ Arrange on a board nobody owns arrange mode for. Today that is only
    // the movies board: board-arrange.js claims the songs one (T4.5), and a
    // film's place on the grid is not the same thing as its place in a list —
    // the recipe ranks the exploration tile in a flow of its own and fills its
    // cell last, so "the order the board shows" cannot be turned back into
    // `rank` without a decision nobody has made yet. Saying so is better than
    // a drag that moves a tile and then snaps back.
    hint.textContent = "Moving the films around is not ready yet — a new film goes on at the end. New ERA chooses which film sits in the exploration tile.";
  }

  const row = document.createElement("div");
  row.className = "sheet-row";
  if (asks) {
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
  freezeBoard(wrap);   // the backdrop paints over the board; THIS puts it to sleep

  closeBtn.addEventListener("click", closeSheet);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeSheet(); });
  // Escape on the DOCUMENT, not the card: the arrange sheet holds no input, so
  // focus is still on the strip button that opened it — and on the two that do
  // hold one, a parent may well be looking at the search grid rather than the
  // box when they give up.
  document.addEventListener("keydown", onKey, true);
  if (asks) {
    const submit = () => {
      const raw = input.value.trim();
      // The hub's own words for an empty add, said here so the round trip is
      // not spent on a blank box.
      if (!raw) {
        say(kind === "songs" ? "Paste a link to the song, or type its name."
                             : "Paste a link to the film, or type its name.");
        return;
      }
      if (kind === "songs") sendSong(raw, goBtn);
      // A pasted address is the answer already; a name is a question.
      else if (isLink(raw)) sendMovie({ url: raw }, goBtn);
      else searchMovies(raw, goBtn);
    };
    goBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    if (kind === "songs") {
      // What the shelf already knows, so a result left over from an earlier add
      // is never reported as this one's. Movies need none of this: their add
      // answers when it is done.
      seenWhen = null;
      fetch("/music/add/status", { cache: "no-store" })
        .then((r) => r.json())
        .then((st) => { seenWhen = st && st.last ? st.last.when : null; })
        .catch(() => {});
    }
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
