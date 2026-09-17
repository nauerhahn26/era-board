// board-talk-door.test.mjs — 💬 PAUSE TO TALK on the boards (T5, dad 9/17).
//
// Dad, watching her mid-song with something to say: the only way off the board
// was 🚪, which kills the kiosk — she came back to a silent screen and had to
// find her song again. So the shared bar (era-core lib/doorbar.js) grew a
// SECOND door: 💬 top-centre. She holds it, the music stops WHERE IT IS, the
// hub parks the engine and brings TD Snap forward; she says her piece; the TD
// Snap tile hands this same kiosk back and the same second plays on.
//
// What this suite pins, board-side:
//   * the bar carries the TWO doors and nothing else — the 9/17 amendment to
//     the board law, the half that is not negotiable (board-input,
//     board-pixel, board-partner-strip and board-lock keep it from their own
//     angles; this suite owns the 💬 itself);
//   * 💬 exists only where there is something to talk TO: `pauseGoes:"tdsnap"`
//     from the hub's /settings. On a VM, a dev browser, or against a hub too
//     old to know the key, the bar looks exactly as it did before 9/17;
//   * TWO SPEEDS (spec §5.1): both doors hold 2 x her Settings dwell, and every
//     tile — song, nav door, More — holds exactly her dwell. No third number;
//   * the pause is a PAUSE, not a stop: same song, same second, same marker,
//     and the clip cap survives it (it counts the song's seconds, not the
//     wall clock);
//   * a `visible` that was never a pause changes nothing — a partner alt-tabs,
//     a screen wakes, and her board is not restarted under her;
//   * and a grown-up's sheet freezes the board but never the two ways out.
//
// Hermetic: /settings is stubbed (the gate's hub has no gaze engine, so its own
// pauseGoes is "home"), /kiosk/pause is stubbed, and the songs recipe comes from
// the gate's synthetic fixture. Drives the live server like its neighbours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

// Viewports come from the contract, never from a literal in here — the same
// rule board-pixel.test.mjs works by (a hard-coded pair is exactly how the gap
// floor drifted away from the doc, dad 9/5). This suite runs from two places:
// the gate's flat dir (era-hub/gate/, where ../public/lib is era-core/lib) and,
// in place, era-board/tests/ — so try both, like board-pixel does.
const CONTRACT = await (async () => {
  for (const p of ["../public/lib/contract.js", "../../era-core/lib/contract.js"]) {
    try { return (await import(new URL(p, import.meta.url))).CONTRACT; } catch { /* next */ }
  }
  throw new Error("lib/contract.js not found from " + import.meta.url);
})();

const BASE = "http://localhost:8377/board/";
const DWELL = 900;              // her Settings hold for this suite
const DOOR = String(2 * DWELL); // ...and what holdForExit() must make of it
const CLIP_MS = 4000;           // long enough that a pause lands mid-clip

const QUIET_CLOTHING = { building: false, ingesting: null, photos: 3, cataloged: 3, aiConfigured: true };
const QUIET_CONTENT = { mode: "local", local: true, skipped: null, building: false, job: null,
                        queued: [], jobs: [], lastScan: null };
const IDLE_ADD = { pack: { id: "media-tools", installed: true }, folder: true, running: null, last: null };

// The hub's /settings as a board sees it. `pauseGoes` is the hub's own answer to
// "is there a gaze engine and a TD Snap to go and talk in?" — an OLD hub omits
// the key, and a missing key must read as "home" (no 💬 against a hub that could
// not honour it).
const settingsBody = (pauseGoes) => JSON.stringify({
  dwellMs: DWELL, settleMs: 0, musicVolCap: 100, exitTo: "tdsnap",
  lockMinutes: 45, lockPasscodeHash: "", childName: "friend", hasProfile: true,
  personalWords: [], doorGoes: pauseGoes === "tdsnap" ? "tdsnap" : "home",
  ...(pauseGoes === undefined ? {} : { pauseGoes }),
});

// One board page. An explicit `pauseGoes: undefined` is the OLD-HUB leg (the
// key is absent from /settings entirely) — which is why it is read with `in`
// rather than a destructuring default, the one spelling that can tell "not
// given" from "given as undefined" apart. `pauses` collects what 💬 sent.
async function open(browser, opts = {}) {
  const { recipe = "songs", pauseAnswer = { action: "paused" },
          viewport = { width: 1920, height: 1080 } } = opts;
  const pauseGoes = "pauseGoes" in opts ? opts.pauseGoes : "tdsnap";
  const pauses = [];
  const exits = [];
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  // FIRST, so the narrower song/status routes registered below still win
  // (playwright runs handlers newest-first): `musicDelayMs` holds every audio
  // blob in flight for that long, which is the only way to reproduce a 💬 that
  // lands while a song is still LOADING — the window in which the element is
  // paused but the song is already hers.
  if (opts.musicDelayMs) {
    await ctx.route("**/music/**", async (r) => {
      await new Promise((res) => setTimeout(res, opts.musicDelayMs));
      await r.continue();
    });
  }
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/music-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/clothing/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CLOTHING) }));
  await ctx.route("**/content/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CONTENT) }));
  await ctx.route("**/music/add/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(IDLE_ADD) }));
  // the hub the gate runs has no engine on 49155, so ITS pauseGoes is "home":
  // the only way to see the 💬 at all is to answer /settings ourselves.
  await ctx.route("**/settings", (r) => r.fulfill({ status: 200, contentType: "application/json", body: settingsBody(pauseGoes) }));
  await ctx.route("**/kiosk/pause", (r) => {
    pauses.push({ body: r.request().postDataJSON(), type: r.request().headers()["content-type"] || "" });
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pauseAnswer) });
  });
  await ctx.route("**/kiosk/exit", (r) => {
    exits.push(1);
    r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"closed"}' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((clip) => {
    try { localStorage.clear(); } catch {}
    window.__testHooks = true;                 // arm the Speech spy in board.js
    window.__musicTest = { clipMs: clip };
    window.__boardTest = { statusMs: 36e5, busyMs: 36e5, pollMs: 36e5, idleMs: 36e5,
                           retryMs: 300, addPollMs: 120, reload: () => {} };
  }, CLIP_MS);
  await page.goto(BASE + "?recipe=" + recipe, { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  return { ctx, page, pauses, exits, errors };
}

// what the bar is made of, from the page's own point of view
const barShape = (page) => page.evaluate(() => {
  const bar = document.querySelector(".msgbar");
  const talk = document.getElementById("barTalk");
  return {
    kids: [...bar.children].map((el) => el.id || String(el.className)),
    dwell: [...bar.querySelectorAll(".dwell")].map((el) => el.id),
    holds: [...bar.querySelectorAll(".dwell")].map((el) => el.dataset.dwellMs),
    talkShown: !!talk && !talk.hidden && talk.getBoundingClientRect().width > 0,
    talkGlyph: talk ? talk.textContent : null,
    talkSay: talk ? talk.dataset.dwellSay : null,
  };
});

const audioState = (page) => page.evaluate(() => ({
  paused: window.Music._audio.paused,
  t: window.Music._audio.currentTime,
  playing: window.Music.playingId(),
}));
const waitPlaying = (page, id) => page.waitForFunction(
  (want) => window.Music.playingId() === want &&
            !window.Music._audio.paused && window.Music._audio.currentTime > 0,
  id, { timeout: 8000 });
// "let the song get somewhere" as a fact about the SONG, not about the clock:
// a sleep long enough on this box is a flake on a loaded one, and the thing
// every pause assertion below needs is simply a position that is not 0.
const playedPast = (page, t) => page.waitForFunction(
  (want) => window.Music._audio.currentTime > want, t, { timeout: 8000 });
// TD Snap hands the screen back: the kiosk is foregrounded and the page goes
// visible again. visibilityState is already "visible" in a driven browser, so
// the event alone is the whole simulation of the real thing.
// Returns what Dwell.suppress() was asked for during THIS return — the bar's
// page-settle window (dwell.js 27P #5b, 600ms per the spec): her gaze is
// already resting somewhere on the screen that just reappeared, and landing on
// the board must not itself select anything. Spied rather than assumed: the
// call lives in era-core's bar, and a board that stopped getting it would look
// exactly the same until she fired a door by blinking back into the room.
const comeBack = (page) => page.evaluate(() => {
  const D = window.Dwell;
  if (D && typeof D.suppress === "function" && !D.__spied) {
    const real = D.suppress.bind(D);
    D.suppress = (ms) => { (window.__suppressLog || []).push(ms); return real(ms); };
    D.__spied = true;
  }
  window.__suppressLog = [];
  document.dispatchEvent(new Event("visibilitychange"));   // synchronous: the log is complete
  return window.__suppressLog;
});

test("the bar carries the two doors and nothing else, both at 2x her dwell", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, { recipe: "songs" });
    const bar = await barShape(page);
    assert.deepEqual(bar.kids, ["barDoor", "barTalk", "partnerStrip"],
                     "🚪, 💬 and the one pointer-only grown-up strip");
    assert.deepEqual(bar.dwell, ["barDoor", "barTalk"], "the two doors are the bar's only dwell targets");
    assert.deepEqual(bar.holds, [DOOR, DOOR], `both doors hold 2 x ${DWELL}ms`);
    assert.equal(bar.talkShown, true, "💬 is on screen when the hub says pauseGoes:tdsnap");
    assert.equal(bar.talkGlyph, "💬", "and it is the speech bubble");
    assert.equal(bar.talkSay, "talk", "named for what it does (silent chrome; the name is for the gates)");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("every tile holds exactly her dwell — no third speed", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, { recipe: "songs" });
    // a content tile (a song) and a nav door (More) — before 9/17 these were
    // two different numbers and neither was hers.
    const song = await page.locator(".tile.type-song").first().getAttribute("data-dwell-ms");
    const more = await page.locator('.tile.type-control:has-text("More")').getAttribute("data-dwell-ms");
    assert.equal(song, String(DWELL), "a song tile holds her dwell");
    assert.equal(more, String(DWELL), "so does the More door — nav buys no bonus any more");
    // ...and nothing anywhere on the page holds anything but dwell or 2 x dwell.
    const holds = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll("[data-dwell-ms]")].map((el) => el.dataset.dwellMs))].sort());
    assert.deepEqual(holds, [String(DWELL), DOOR].sort(), "two speeds on the whole page: " + holds.join(","));
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("no gaze engine (or an old hub): the bar is exactly what it was before 9/17", async () => {
  const browser = await chromium.launch();
  try {
    const legs = [
      ["no engine on the bus", { recipe: "songs", pauseGoes: "home" }],
      // the key present-but-undefined spelling IS the old-hub leg: `open` reads
      // it with `in`, so this stands for a /settings body with no pauseGoes.
      ["a hub that never heard of pausing", { recipe: "songs", pauseGoes: undefined }],
    ];
    for (const [leg, o] of legs) {
      const { ctx, page, errors } = await open(browser, o);
      const bar = await barShape(page);
      assert.equal(bar.talkShown, false, `${leg}: no 💬 on screen`);
      assert.equal(await page.locator("#barTalk:visible").count(), 0, `${leg}: nothing to look at`);
      assert.equal(await page.locator("#barDoor:visible").count(), 1, `${leg}: 🚪 is untouched`);
      assert.deepEqual(errors, [], `${leg}: no page errors`);
      await ctx.close();
    }
  } finally { await browser.close(); }
});

test("💬 mid-song: the music holds its place and the hub is told where she is", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, pauses, exits, errors } = await open(browser, { recipe: "songs" });
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, "test-song-1");
    await playedPast(page, 0.2);              // let the song get somewhere
    const before = await audioState(page);
    assert.equal(before.paused, false, "she is mid-song");

    await page.locator("#barTalk").click();
    await page.waitForFunction(() => window.Music._audio.paused, null, { timeout: 4000 });
    const held = await audioState(page);
    assert.ok(held.t >= before.t - 0.01, `the element kept its place (${before.t} -> ${held.t})`);
    assert.ok(held.t > 0.05, "and that place is not the beginning");
    assert.equal(held.playing, "test-song-1",
                 "this is still the song that is on: a pause is not a stop, the marker stays");
    assert.equal(await page.locator(".tile.playing").count(), 1, "...and so does her ring on the tile");

    assert.equal(pauses.length, 1, "one POST /kiosk/pause");
    assert.deepEqual(pauses[0].body, { path: "/board/?recipe=songs" },
                     "it names the page the launcher will ask to come back to — path + query, no hash");
    assert.equal(exits.length, 0, "a pause the hub honoured never becomes an exit");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("she comes back: the same second plays on", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, { recipe: "songs" });
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, "test-song-1");
    await playedPast(page, 0.2);
    await page.locator("#barTalk").click();
    await page.waitForFunction(() => window.Music._audio.paused, null, { timeout: 4000 });
    const held = await audioState(page);

    const suppressed = await comeBack(page);
    assert.deepEqual(suppressed, [600],
                     "gaze arming is blocked for the settle window as the screen reappears");
    await page.waitForFunction(() => !window.Music._audio.paused, null, { timeout: 4000 });
    const back = await audioState(page);
    assert.equal(back.playing, "test-song-1", "the same song");
    assert.ok(back.t >= held.t - 0.01, `from where she left it (${held.t} -> ${back.t})`);
    assert.ok(back.t < held.t + 1.5, "not restarted from the top");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("💬 while the song is still LOADING: it never starts under her talker", async () => {
  const browser = await chromium.launch();
  try {
    // A song is a blob fetch away, and on a school wifi that is seconds. She
    // picks one and, before a note has sounded, looks at 💬 — the pick IS hers
    // (the tile already wears the ring), but the <audio> element has no src yet
    // and is therefore "paused". A pause that reads the ELEMENT instead of the
    // PICK does nothing at all here; the blob then lands under a minimized
    // kiosk and the song plays at full volume under her TD Snap. This is the
    // one leg where being quiet has to outlast the load.
    const { ctx, page, pauses, exits, errors } = await open(browser, { recipe: "songs", musicDelayMs: 2500 });
    await page.locator(".tile.type-song").first().click();
    await page.waitForFunction(() => window.Music.playingId() === "test-song-1", null, { timeout: 4000 });
    assert.equal((await audioState(page)).t, 0, "nothing has sounded yet — the blob is still in flight");

    await page.locator("#barTalk").click();
    // the blob landing is the moment of truth: src is set on both sides of the
    // fix, so it is a fair synchronisation point and not a sleep.
    await page.waitForFunction(() => /^blob:/.test(window.Music._audio.src || ""), null, { timeout: 8000 });
    await page.waitForTimeout(400);           // ...and give the bug room to make a sound
    const after = await audioState(page);
    assert.equal(after.paused, true, "she is in TD Snap: the board stayed silent");
    assert.equal(after.t, 0, "and the song is still waiting at its first note");
    assert.equal(after.playing, "test-song-1", "it is still HER pick — a pause is not a stop");
    assert.equal(pauses.length, 1, "one POST /kiosk/pause");
    assert.equal(exits.length, 0, "a pause the hub honoured never becomes an exit");

    // ...and coming back plays the song she asked for, from the top.
    await comeBack(page);
    await page.waitForFunction(() => !window.Music._audio.paused && window.Music._audio.currentTime > 0,
                               null, { timeout: 4000 });
    assert.equal((await audioState(page)).playing, "test-song-1", "her song, once she is back to hear it");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test('💬 with no engine to answer ({action:"home"}): 💬 becomes the 🚪, and goes quiet on the way', async () => {
  const browser = await chromium.launch();
  try {
    // The hub answers "home" when nothing was brought forward — there is no
    // gaze engine to park, so there is nothing to talk TO. The bar must fall
    // through to the 🚪 path rather than leave her silent AND on screen. The
    // board's half of that is a pause() immediately followed by a stop() on the
    // same element, which is the only place those two run back to back.
    const { ctx, page, pauses, exits, errors } = await open(browser,
      { recipe: "songs", pauseAnswer: { action: "home" } });
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, "test-song-1");
    await playedPast(page, 0.2);

    await page.locator("#barTalk").click();
    await page.waitForFunction(() => window.Music.playingId() === null, null, { timeout: 4000 });
    assert.equal(pauses.length, 1, "it asked to pause first");
    assert.equal(exits.length, 1, "...and on 'home' it left through the door instead");
    assert.equal((await audioState(page)).paused, true, "the music really stopped");
    assert.equal(await page.locator(".tile.playing").count(), 0, "and the ring went with it");
    // the exit answered {action:"closed"}: the hub is handing the screen over,
    // so the page stays put rather than navigating to /home/.
    assert.ok(/\/board\//.test(page.url()), "a closed kiosk stays where it is, got " + page.url());
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a visible that was never a pause changes nothing", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, { recipe: "songs" });
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, "test-song-1");
    // a partner alt-tabs away and back while the song is playing
    await comeBack(page);
    await page.waitForTimeout(200);
    assert.equal((await audioState(page)).paused, false, "still playing, untouched");

    // ...and after a real stop, a stray visible must not start the music again
    await page.locator(".tile.type-stop").click();
    await page.waitForFunction(() => window.Music.playingId() === null, null, { timeout: 4000 });
    await comeBack(page);
    await page.waitForTimeout(300);
    const s = await audioState(page);
    assert.equal(s.paused, true, "a stopped board stays silent");
    assert.equal(s.playing, null, "and stays stopped");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a grown-up's sheet freezes the board but never the two ways out", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, { recipe: "songs" });
    await page.locator("#stripAdd").click();
    await page.locator("#partnerSheet").waitFor();
    const state = await page.evaluate(() => {
      const live = (id) => {
        const el = document.getElementById(id);
        return { dwell: el.classList.contains("dwell"),
                 disabled: el.hasAttribute("data-dwell-disabled") };
      };
      return { door: live("barDoor"), talk: live("barTalk"),
               tilesAsleep: [...document.querySelectorAll(".board-area .tile")]
                 .every((el) => !el.classList.contains("dwell")) };
    });
    assert.equal(state.tilesAsleep, true, "the board underneath is furniture");
    assert.deepEqual(state.door, { dwell: true, disabled: false }, "🚪 is still live");
    assert.deepEqual(state.talk, { dwell: true, disabled: false },
                     "and so is 💬 — she can still say something while a grown-up types");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// Both of the contract's gate viewports (CONTRACT.gateViewports). The pixel
// gate itself renders against the gate's own hub, which has no engine on the
// bus and therefore never shows the 💬 at all — so the only place the second
// door's geometry is ever measured in a browser is HERE. It pays for both
// screens, and for the grid underneath: a centred door that overlapped the top
// row would be a mishit waiting to happen on the one device that has it.
for (const { w, h } of CONTRACT.gateViewports) {
  test(`at ${w}x${h} the two doors, the strip and the grid never meet`, async () => {
    const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await open(browser,
        { recipe: "songs", viewport: { width: w, height: h } });
      const geo = await page.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        const bar = document.querySelector(".msgbar").getBoundingClientRect();
        const talk = r("barTalk");
        const hit = [...document.querySelectorAll(".board-area .tile, .board-area .cell")]
          .map((el) => el.getBoundingClientRect())
          .filter((b) => b.left < talk.right && b.right > talk.left &&
                         b.top < talk.bottom && b.bottom > talk.top).length;
        const topRow = Math.min(...[...document.querySelectorAll(".board-area .cell")]
          .map((el) => el.getBoundingClientRect().top));
        return { door: r("barDoor"), talk, strip: r("partnerStrip"), bar, hit, topRow };
      });
      assert.ok(geo.door.right <= geo.talk.left, "🚪 ends before 💬 begins");
      assert.ok(geo.talk.right <= geo.strip.left, "💬 ends before the strip begins");
      // 💬 is CENTRED on the bar, not packed after the door: her motor plan for
      // it must not move when a board grows a strip.
      const mid = (geo.talk.left + geo.talk.right) / 2;
      assert.ok(Math.abs(mid - (geo.bar.left + geo.bar.right) / 2) <= 1.5,
                `💬 is centred on the bar (centre ${mid.toFixed(1)} of ${geo.bar.width})`);
      // both doors are the strip's own height, and twice as wide as tall
      for (const [name, d] of [["🚪", geo.door], ["💬", geo.talk]]) {
        assert.ok(Math.abs(d.height - geo.door.height) < 1.5, `${name} is the same height as its twin`);
        assert.ok(d.width >= 2 * d.height - 2, `${name} is double-wide bar chrome`);
        assert.ok(d.top >= geo.bar.top - 0.5 && d.bottom <= geo.bar.bottom + 0.5,
                  `${name} sits inside the strip`);
      }
      assert.equal(geo.hit, 0, "💬 overlaps no cell of the grid below it");
      // the mishit floor the pixel gate enforces between targets (contract
      // gapFloor, 14px since dad's 9/5 tablet spacing) holds under 💬 too.
      assert.ok(geo.topRow - geo.talk.bottom >= 14,
                `💬 clears the top row by the gap floor (${(geo.topRow - geo.talk.bottom).toFixed(1)}px)`);
      assert.deepEqual(errors, [], "no page errors");
      await ctx.close();
    } finally { await browser.close(); }
  });
}
