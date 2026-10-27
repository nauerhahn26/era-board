// Board adapters for shared per-app locks. Gesture/keypad coverage lives in
// era-core/tests/app-lock-ui.test.mjs. Execution is deferred by the maintainer.
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
// It gets the same CDP session and the finger's start point, so a test can
// move the finger that is already down.
async function hold(page, selector, ms, midway) {
  const box = await page.locator(selector).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    if (midway) { await page.waitForTimeout(Math.min(400, ms)); await midway({ cdp, x, y }); await page.waitForTimeout(Math.max(0, ms - 400)); }
    else await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach().catch(() => {}); }
}

const current = page => page.evaluate(() => ({
  locked: window.AppLock.isLocked(), board: window.Board.session.currentId,
  playing: window.Music?.playingId() || null,
  visible: !document.querySelector('.app-lock-curtain').hidden,
}));

test("a real finger locks Music, stops the player and keeps the exit usable", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, exits, errors } = await open(browser, "songs");
    await hold(page, '#stripLock', 1900);
    await page.waitForFunction(() => window.AppLock.isLocked());
    const state = await current(page);
    assert.equal(state.visible, true); assert.equal(state.playing, null);
    assert.equal(await page.locator('#barDoor').isVisible(), true);
    await page.locator('#barDoor').click(); assert.equal(exits.length, 1);
    assert.deepEqual(errors, []); await ctx.close();
  } finally { await browser.close(); }
});

test("a finger drifting during its hold still locks", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, 'songs');
    await hold(page, '#stripLock', 2000, async ({ cdp, x, y }) => {
      for (const dx of [10, 20, 30]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y }] });
    });
    await page.waitForFunction(() => window.AppLock.isLocked());
    assert.deepEqual(errors, []); await ctx.close();
  } finally { await browser.close(); }
});

test("locked board navigation and direct synthetic media activation are refused", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, 'songs', { seed: { until: 0 } });
    const before = await current(page);
    await page.evaluate(() => { for (const tile of document.querySelectorAll('.board-area .tile')) tile.click(); });
    const after = await current(page);
    assert.equal(after.board, before.board); assert.equal(after.playing, null);
    assert.deepEqual(errors, []); await ctx.close();
  } finally { await browser.close(); }
});

test("new Music locks do not lock Movies or Clothing", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, 'songs');
    await hold(page, '#stripLock', 1900); await page.waitForFunction(() => window.AppLock.isLocked());
    const states = await page.evaluate(() => ['music', 'movies', 'board'].map(id => window.AppLock.get(id).isLocked()));
    assert.deepEqual(states, [true, false, false]);
    const sibling = await ctx.newPage(); await sibling.goto(BASE + '?recipe=movies');
    await sibling.waitForSelector('#stripLock');
    assert.equal(await sibling.evaluate(() => window.AppLock.isLocked()), false);
    assert.deepEqual(errors, []); await ctx.close();
  } finally { await browser.close(); }
});

test("legacy lock migrates, and unlocking Music leaves the other migrated locks", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, 'songs', { seed: { until: 0 } });
    assert.equal(await page.evaluate(() => localStorage.getItem('era.lock')), null);
    await hold(page, '#stripLock', 1900); await page.waitForFunction(() => !window.AppLock.isLocked());
    assert.deepEqual(await page.evaluate(() => ['music', 'movies', 'this-week'].map(id => window.AppLock.get(id).isLocked())), [false, true, true]);
    assert.deepEqual(errors, []); await ctx.close();
  } finally { await browser.close(); }
});

test("Clothing has its own shared lock control", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, '');
    await hold(page, '#stripLock', 1900); await page.waitForFunction(() => window.AppLock.isLocked());
    assert.equal(await page.evaluate(() => window.AppLock.get('music').isLocked()), false);
    assert.equal((await current(page)).visible, true);
    assert.deepEqual(errors, []); await ctx.close();
  } finally { await browser.close(); }
});
