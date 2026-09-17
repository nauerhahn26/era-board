// board-lock.test.mjs — the media lock (T3 + T4, spec 2026-09-14).
//
// Dad 9/14: "in class, or when he is poking the tablet, I want to stop the music
// and the movies with one button." This is DETERRENCE, NOT SECURITY — another
// device is not locked, clearing the browser profile clears it, and the passcode
// is only hashed. What it must never do is cost her anything: the board still
// renders, the nav doors still navigate, and the DOOR is never taken away.
//
// So this suite pins the price of the button as hard as board-partner-strip.mjs
// pinned the strip's:
//   * the lock rides in the pointer-only #partnerStrip, carries no .dwell and no
//     data-dwell-* attribute, and the two DOORS stay the message bar's only
//     .dwell (the 9/4 amendment's second half is law; 9/17 made it two doors —
//     🚪 leave and 💬 pause-to-talk — and not one thing more);
//   * it answers a FINGER and nothing else — a tap does nothing, a mouse hold
//     does nothing (ERAgaze drives the real cursor, so gaze == mouse here);
//   * locked, only the media tiles (song / full / stop / movie / episode) go
//     inert — class AND attribute, the freezeBoard pattern — and onTile refuses
//     them a second time, so a touch on a disarmed tile is silent too;
//   * a re-render (a page turn) hands back tiles that are still asleep;
//   * and the way out (hold again, keypad if a passcode is set) works.
//
// HOW THE HOLD IS DRIVEN (plan STOP (b)): Playwright's page.touchscreen can only
// TAP — there is no down/move/up on it — so a 1600 ms finger is dispatched over
// CDP (Input.dispatchTouchEvent touchStart … touchEnd). Those are REAL trusted
// pointer events with pointerType "touch", which is what the button filters on,
// so the test exercises the same path a finger does rather than a synthetic
// dispatchEvent the production code could not tell apart from a script.
//
// Hermetic: every hub route the board touches is stubbed (including /settings,
// which is where lockMinutes and lockPasscodeHash come from), so the suite never
// reaches the family's own settings and never launches anything. The page itself
// is served by the gate's hub (port re-pointed by era-gate.sh), so this suite
// holds no port of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/";
const QUIET_CLOTHING = { building: false, ingesting: null, photos: 3, cataloged: 3, aiConfigured: true };
const QUIET_CONTENT = { mode: "local", local: true, skipped: null, building: false, job: null,
                        queued: [], jobs: [], lastScan: null };
const IDLE_ADD = { pack: { id: "media-tools", installed: true }, folder: true, running: null, last: null };
// what /settings answers, minus the lock keys each case sets for itself.
const BASE_SETTINGS = { dwellMs: 1200, settleMs: 250, musicVolCap: 100, exitTo: "home" };

// sha256("2468") — the passcode the keypad cases type. Computed here in node so
// the fixture and the page can never quietly disagree about the hash shape.
const { createHash } = await import("node:crypto");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// One board page with every hub route stubbed. `dial.settings` is the lock half
// of /settings for this case; `exits` collects the door's round trip.
async function open(browser, recipe, dial) {
  const d = Object.assign({ settings: { lockMinutes: 45, lockPasscodeHash: "" }, seed: null }, dial || {});
  const exits = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true });
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/music-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/movie-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/settings", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify(Object.assign({}, BASE_SETTINGS, d.settings)) }));
  await ctx.route("**/clothing/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CLOTHING) }));
  await ctx.route("**/content/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CONTENT) }));
  await ctx.route("**/music/add/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(IDLE_ADD) }));
  await ctx.route("**/kiosk/exit", (r) => {
    exits.push(r.request().method());
    r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"closed"}' });
  });
  // the board never plays video: ERAgaze's bus is not here and must not be waited on
  await ctx.route("http://127.0.0.1:49155/**", (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((seed) => {
    try { localStorage.clear(); } catch {}
    // a lock written before this board ever opened (a sibling tab, or the last
    // session): `seed` is {until} exactly as board-lock.js writes it.
    if (seed) { try { localStorage.setItem("era.lock", JSON.stringify(seed)); } catch {} }
    window.__activateCount = 0;
    document.addEventListener("dwell:activate", () => { window.__activateCount++; }, true);
    window.__boardTest = { statusMs: 60 * 60 * 1000, busyMs: 60 * 60 * 1000,
                           pollMs: 60 * 60 * 1000, idleMs: 60 * 60 * 1000, retryMs: 300,
                           addPollMs: 120, reload: () => {} };
    window.__musicTest = { clipMs: 1500 };
  }, d.seed);
  await page.goto(BASE + (recipe ? "?recipe=" + recipe : ""), { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  await page.waitForSelector("#stripLock", { timeout: 8000 });
  return { ctx, page, exits, errors };
}

// A real finger on a real element, held for `ms`. CDP, not page.touchscreen:
// the latter only taps. touchStart -> pointerdown{pointerType:"touch"} in the
// page, which is precisely what board-lock.js filters on. `midway` is called
// with the finger still down, which is the only moment the fill ring exists.
async function hold(page, selector, ms, midway) {
  const box = await page.locator(selector).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    if (midway) { await page.waitForTimeout(Math.min(400, ms)); await midway(); await page.waitForTimeout(Math.max(0, ms - 400)); }
    else await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach().catch(() => {}); }
}

const lockState = (page) => page.evaluate(() => {
  const bar = document.querySelector(".msgbar");
  const warn = document.getElementById("lockWarn");
  const btn = document.getElementById("stripLock");
  const tiles = [...document.querySelectorAll(".board-area .tile")];
  const media = tiles.filter((el) => ["song", "full", "stop", "movie", "episode"]
    .includes(el.dataset.tileType || ""));
  return {
    stored: localStorage.getItem("era.lock"),
    btnLocked: !!btn && btn.classList.contains("locked"),
    btnDwell: !!btn && (btn.classList.contains("dwell") ||
      [...btn.attributes].some((a) => a.name.startsWith("data-dwell"))),
    warn: warn && warn.classList.contains("show") ? warn.textContent : null,
    warnDwell: !!warn && (warn.classList.contains("dwell") || warn.querySelectorAll(".dwell").length > 0),
    barDwell: [...bar.querySelectorAll(".dwell")].map((el) => el.id),
    media: media.length,
    mediaAsleep: media.filter((el) => !el.classList.contains("dwell") &&
      el.hasAttribute("data-dwell-disabled")).length,
    // every tile that is NOT media must be untouched — nav doors keep working
    otherTiles: tiles.length - media.length,
    otherAwake: tiles.filter((el) => !["song", "full", "stop", "movie", "episode"]
      .includes(el.dataset.tileType || "")).filter((el) => el.classList.contains("dwell")).length,
    board: window.Board.session.currentId,
    playing: window.Music ? window.Music.playingId() : null,
  };
});

// ---------------------------------------------------------------- T3: the hold

test("a 1600ms finger on 🔒 locks the board; the strip stays gaze-proof", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs");
    const before = await lockState(page);
    assert.equal(before.stored, null, "nothing locked to start with");
    assert.ok(before.media > 0, "the songs board has media tiles to disarm");
    assert.equal(before.mediaAsleep, 0, "…and they are hers to press");

    // …and the hold has to SHOW, or a grown-up cannot tell a button that is
    // thinking from one that is broken: .holding is the fill ring's hook, and
    // --hold-ms is what the ring's sweep is timed to. Both must be there while
    // the finger is still down, and gone when it lifts.
    let ring = null;
    await hold(page, "#stripLock", 1900, async () => {          // > the lock's own 1600ms finger hold
      ring = await page.evaluate(() => {
        const b = document.getElementById("stripLock");
        return { holding: b.classList.contains("holding"),
                 holdMs: b.style.getPropertyValue("--hold-ms").trim() };
      });
    });
    assert.equal(ring.holding, true, "the ring runs while the finger is down");
    assert.equal(ring.holdMs, (await page.evaluate(() => window.__lockTest.holdMs)) + "ms",
                 "and it is timed to the contract's hold, not to a number in the stylesheet");
    await page.waitForFunction(() => !!localStorage.getItem("era.lock"), null, { timeout: 4000 });
    assert.equal(await page.locator("#stripLock.holding").count(), 0, "the ring stops when the lock lands");

    const after = await lockState(page);
    const stored = JSON.parse(after.stored);
    assert.ok(stored.until > Date.now() + 40 * 60 * 1000, "45 minutes from now: " + stored.until);
    assert.equal(after.btnLocked, true, "the button says so");
    assert.equal(after.btnDwell, false, "and is STILL not a gaze target");
    assert.deepEqual(after.barDwell, ["barDoor", "barTalk"], "the two doors are the bar's only dwell targets");
    assert.match(after.warn, /^Locked until \d{1,2}:\d{2}/, "the banner names the time: " + after.warn);
    assert.equal(after.warnDwell, false, "the banner is touch-only too");
    assert.equal(after.mediaAsleep, after.media, "every media tile is inert");
    assert.equal(after.otherAwake, after.otherTiles, "and nothing else was touched");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a tap does nothing, and a mouse held for two seconds does nothing", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs");
    await hold(page, "#stripLock", 200);       // a tap: well under the hold
    await page.waitForTimeout(600);
    assert.equal((await lockState(page)).stored, null, "a tap is not a lock");

    // ERAgaze moves the REAL cursor, so a parked gaze IS a parked mouse: the
    // button must be deaf to both, or the boy watching over a shoulder could
    // stare the music off (and back on) himself.
    const box = await page.locator("#stripLock").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(2200);
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal((await lockState(page)).stored, null, "a mouse hold is not a lock");
    assert.equal(await page.evaluate(() => window.__activateCount), 0, "and no dwell ever fired on the strip");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// ----------------------------------------------------- T3: what locked COSTS

test("locked: a song tile is inert and silent, and the door still leaves", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, exits, errors } = await open(browser, "songs", { seed: { until: 0 } });
    const s = await lockState(page);
    assert.equal(s.mediaAsleep, s.media, "a lock written before the board opened is honoured on load");
    assert.equal(s.warn, "Locked", "until 0 = until a grown-up unlocks it");

    // belt and braces: the tile is not a gaze target any more, and a FINGER on
    // it is refused too — onTile checks the lock after barge-in.
    const tile = page.locator(".board-area .tile.type-song").first();
    await tile.click();
    await page.waitForTimeout(800);
    const after = await lockState(page);
    assert.equal(after.playing, null, "no music started");
    assert.equal(after.board, s.board, "and the board did not even turn the page");

    // the way out is NEVER taken away from her.
    assert.deepEqual(after.barDwell, ["barDoor", "barTalk"], "the two doors are still the bar's only dwell targets");
    await page.locator("#barDoor").click();
    await page.waitForTimeout(600);
    assert.equal(exits.length, 1, "the door still hands the screen back");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("locked: a page turn hands back tiles that are still asleep", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs", { seed: { until: 0 } });
    const first = await lockState(page);
    assert.equal(first.mediaAsleep, first.media);

    // "More" is a nav door — it must still work while locked (locked is
    // "reachable but inert", not "frozen") — and the page it draws is fresh
    // DOM that has never seen applyLock.
    await page.locator('.board-area .tile.type-control:has-text("More")').first().click();
    await page.waitForTimeout(500);
    const second = await lockState(page);
    assert.notEqual(second.board, first.board, "the nav door still navigates");
    assert.ok(second.media > 0, "the new page has media tiles");
    assert.equal(second.mediaAsleep, second.media, "…and the re-render handed them over already asleep");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a lock whose time is up is gone by the time the board draws", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs", { seed: { until: Date.now() - 1000 } });
    const s = await lockState(page);
    assert.equal(s.stored, null, "an expired lock is cleared on the first read, not left to rot");
    assert.equal(s.btnLocked, false, "the button is open");
    assert.equal(s.warn, null, "no banner");
    assert.equal(s.mediaAsleep, 0, "and the board is hers");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("no passcode: holding 🔒 again gives the board back", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs",
      { seed: { until: 0 }, settings: { lockMinutes: 45, lockPasscodeHash: "" } });
    assert.equal((await lockState(page)).btnLocked, true);

    await hold(page, "#stripLock", 1900);
    await page.waitForFunction(() => !localStorage.getItem("era.lock"), null, { timeout: 4000 });
    const s = await lockState(page);
    assert.equal(s.btnLocked, false, "the button is open again");
    assert.equal(s.warn, null, "the banner is gone");
    assert.equal(s.mediaAsleep, 0, "every media tile is hers again");
    assert.equal(s.media > 0 && s.mediaAsleep === 0, true);
    assert.equal(await page.locator("#lockPad").count(), 0, "with no passcode set there is no keypad");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("the lock is the same lock in every tab: a sibling's write reaches this board", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs");
    // what a `storage` event looks like from the other tab. (Playwright cannot
    // make two same-origin pages talk, so the event is replayed here; what is
    // under test is that board-lock.js LISTENS, not that Chromium fires.)
    await page.evaluate(() => {
      window.__lockTest.writeLock(0);
      window.dispatchEvent(new StorageEvent("storage", { key: "era.lock" }));
    });
    await page.waitForFunction(() => document.getElementById("stripLock").classList.contains("locked"),
                               null, { timeout: 4000 });
    const s = await lockState(page);
    assert.equal(s.mediaAsleep, s.media, "the board this tab is showing goes inert too");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("the movies board locks the same way, and a locked movie tile launches nothing", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "movies", { seed: { until: 0 } });
    const s = await lockState(page);
    assert.ok(s.media > 0, "the movies board has movie/show tiles");
    assert.equal(s.mediaAsleep, s.media, "the media ones are inert");
    const movies = page.locator(".board-area .tile.type-movie, .board-area .tile.type-episode");
    assert.ok(await movies.count() > 0, "the fixture catalog has something to launch");
    await movies.first().click();
    await page.waitForTimeout(600);
    // launch-failed is the dashed flag launchMovie paints when ERAgaze refuses
    // (its bus is aborted in this context). Its ABSENCE is the proof the lock
    // stopped the press before the hand-off, not after it.
    assert.equal(await page.locator(".tile.launch-failed").count(), 0,
                 "a locked movie tile does not even TRY ERAgaze");
    assert.equal(await page.locator("#launchWarn.show").count(), 0, "…and says nothing about it");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// --------------------------------------------------- T3: the banner's manners

test("the banner sits ABOVE the no-sound footer instead of painting on it", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs");
    // The degraded-TTS footer, in the same state board.js puts it in when
    // speech.init() comes back "off" — bottom:6px, which is where #lockWarn
    // starts too. The recorded 9/14 run had both up and read "…check the
    // speakers or W[Locked until 10:45 PM]": the lock's amber plate painted
    // over the end of the sentence a grown-up needed.
    const foot = await page.evaluate(() => {
      const w = document.getElementById("ttsWarn");
      w.classList.add("show");
      const r = w.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    });
    assert.ok(foot.height > 0, "the no-sound footer is really showing");

    await hold(page, "#stripLock", 1900);
    await page.waitForFunction(() => !!localStorage.getItem("era.lock"), null, { timeout: 4000 });
    await page.locator("#lockWarn.show").waitFor({ timeout: 4000 });

    const m = await page.evaluate(() => {
      const w = document.getElementById("lockWarn"), t = document.getElementById("ttsWarn");
      const wr = w.getBoundingClientRect(), tr = t.getBoundingClientRect();
      return { warnBottom: wr.bottom, inline: w.style.bottom,
               footTop: tr.top, footBottom: tr.bottom };
    });
    assert.ok(m.warnBottom <= m.footTop,
              "the lock banner clears the footer: " + m.warnBottom + " > " + m.footTop);
    assert.ok(parseInt(m.inline, 10) >= Math.round(foot.height) + 6,
              "and it measured rather than guessed: bottom " + m.inline + " for a " +
              Math.round(foot.height) + "px footer");
    // the standing footers never move for a banner — the sentence stays where
    // the grown-up's eye already found it.
    assert.equal(m.footTop, foot.top, "the no-sound footer did not move");
    assert.equal(m.footBottom, foot.bottom, "…at either edge");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// ------------------------------------------------------------- T4: the keypad

const PASS = { lockMinutes: 45, lockPasscodeHash: sha256("2468") };

async function type(page, digits) {
  for (const d of digits) await page.locator("#lockPad button[data-key='" + d + "']").click();
}

test("passcode set: the hold opens a keypad, and a wrong one keeps the lock", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs", { seed: { until: 0 }, settings: PASS });
    await hold(page, "#stripLock", 1900);
    await page.locator("#lockPad").waitFor({ timeout: 4000 });

    // grown-up surface, but it is on HER screen: nothing in it may be a gaze
    // target, and every key is a >=90px target (invariants law 1).
    const pad = await page.evaluate(() => {
      const p = document.getElementById("lockPad");
      const keys = [...p.querySelectorAll("button")];
      return {
        dwell: p.classList.contains("dwell") || p.querySelectorAll(".dwell").length > 0,
        dwellAttrs: [p, ...p.querySelectorAll("*")]
          .flatMap((el) => [...el.attributes].map((a) => a.name)).filter((n) => n.startsWith("data-dwell")),
        small: keys.map((b) => b.getBoundingClientRect())
          .filter((r) => r.width < 90 || r.height < 90).length,
        keys: keys.length,
        dots: p.querySelectorAll(".lockpad-dot").length,
        ok: p.querySelectorAll("[data-key='ok']").length,
      };
    });
    assert.equal(pad.dwell, false, "no gaze target in the keypad");
    assert.deepEqual(pad.dwellAttrs, [], "and no dwell attribute either");
    assert.equal(pad.keys, 12, "0-9 and ⌫ Cancel, and nothing else: " + pad.keys);
    assert.equal(pad.small, 0, "every key is at least 90x90");
    // The passcode is ALWAYS four digits now (Settings enforces it), so the
    // fourth digit IS the ✓ — there is no ✓ key left to press, and four dots
    // is the whole of what a grown-up has to fill.
    assert.equal(pad.dots, 4, "four dots, not six");
    assert.equal(pad.ok, 0, "and no ✓ key at all");

    // ⌫ takes back the last digit, because a grown-up entering this at the back
    // of a classroom cannot see the digits they typed — only the dots.
    await type(page, "135");
    assert.equal(await page.evaluate(() => document.querySelectorAll("#lockPad .lockpad-dot.on").length), 3,
                 "three digits is three dots, and submits nothing");
    assert.ok(await page.evaluate(() => !!localStorage.getItem("era.lock")), "still locked mid-entry");
    await page.locator("#lockPad button[data-key='del']").click();
    assert.equal(await page.evaluate(() => document.querySelectorAll("#lockPad .lockpad-dot.on").length), 2,
                 "⌫ gives one back");

    // …and the fourth digit submits on its own: nothing is clicked after it.
    await type(page, "57");                       // 1357: wrong
    await page.waitForTimeout(500);
    const s = await lockState(page);
    assert.ok(s.stored, "a wrong passcode leaves the lock exactly where it was");
    assert.equal(s.mediaAsleep, s.media, "…and the tiles asleep");
    assert.equal(await page.locator("#lockPad").count(), 1, "the pad stays up for another try");
    assert.equal(await page.locator("#lockPad .lockpad-card.shake").count(), 1,
                 "it moved and stayed shut");
    assert.equal(await page.evaluate(() => document.querySelectorAll("#lockPad .lockpad-dot.on").length), 0,
                 "with the entry cleared");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("passcode set: the right one unlocks and takes the keypad with it", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs", { seed: { until: 0 }, settings: PASS });
    await hold(page, "#stripLock", 1900);
    await page.locator("#lockPad").waitFor({ timeout: 4000 });
    await type(page, "2468");                     // the fourth digit is the ✓
    await page.waitForFunction(() => !localStorage.getItem("era.lock"), null, { timeout: 4000 });
    await page.waitForFunction(() => !document.getElementById("lockPad"), null, { timeout: 4000 });
    const s = await lockState(page);
    assert.equal(s.btnLocked, false, "the button is open");
    assert.equal(s.mediaAsleep, 0, "the board is hers again");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("Cancel closes the keypad and leaves the board locked", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs", { seed: { until: 0 }, settings: PASS });
    await hold(page, "#stripLock", 1900);
    await page.locator("#lockPad").waitFor({ timeout: 4000 });
    await page.locator("#lockPad button[data-key='cancel']").click();
    await page.waitForFunction(() => !document.getElementById("lockPad"), null, { timeout: 4000 });
    const s = await lockState(page);
    assert.ok(s.stored, "still locked");
    assert.equal(s.mediaAsleep, s.media, "still inert");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});
