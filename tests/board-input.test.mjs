// T2.3 — input parity + voice wiring tests for /board/ (Phase 2).
// Drives the LIVE server at :8377. Two input paths on the SAME tiles:
//   touch tap  -> immediate activation (no dwell wait)
//   gaze hover -> dwell:activate after the tile's hold (synthetic mousemove)
// Voice is asserted via a Speech spy: board.js installs it only when
// window.__testHooks is set (addInitScript, before any page script), logging
// say/stop calls in order to window.__speechLog. Verifies barge-in ordering
// (stop before say), SILENT nav doors, and the slim door-only bar (dad 9/2).
//
// Kept hermetic like the pixel gate: /voices disabled, /tts 503, /log swallowed.
// Runs under `node --test` or `node tests/board-input.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/";

// Build a hermetic page with the test hooks armed BEFORE any script runs.
async function makePage(browser, { touch = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    hasTouch: touch,
  });
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" })); // hermetic: never write her real pick history
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.addInitScript(() => {
    window.__testHooks = true;               // arm the Speech spy in board.js
    window.__activateCount = 0;              // count dwell:activate fires
    document.addEventListener("dwell:activate", () => { window.__activateCount++; }, true);
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  return { ctx, page };
}

const log = (page) => page.evaluate(() => window.__speechLog.slice());
const resetLog = (page) => page.evaluate(() => { window.__speechLog.length = 0; });
const centerOf = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
// dwell v6.2 page-settle (contract §C, 27P #5b): every render() suppresses gaze
// arming for settleMs (250), including the initial mount the tests wait on. Real
// gaze input is a CONTINUOUS sample stream (gaze bus / ERAgaze-driven cursor), so
// the first post-settle sample arms the tile; Playwright's single mouse.move is
// one lone sample — if it lands inside the window it is swallowed and a parked
// pointer never arms (arming is edge-triggered by design; the streaming re-arm
// case is proven in dwell-engine.test.mjs). Wait out the window first so the
// single synthetic move models the first post-settle sample.
const settled = (page) => page.waitForFunction(
  () => window.Dwell && window.Dwell.state().suppressedMs === 0);

test("touch tap on an outfit tile navigates AND speaks the pick (say_on_load)", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, { touch: true });
    // today-board outfit tiles carry `load` + `say_on_load`: the first pick is
    // voiced as it opens the confirm page (dad 7/24), unlike a plain silent door.
    const tile = page.locator(".tile.type-outfit").first();
    const say = await tile.evaluate((el) => el.dataset.dwellSay);
    await tile.tap();
    // immediate: no dwell wait; board already navigated off root.
    const nav = await page.evaluate(() => window.Board.session.currentId);
    assert.notEqual(nav, "today", "tap must navigate immediately");
    // barge-in order preserved: stop BEFORE the spoken pick.
    const l = await log(page);
    assert.equal(l.length, 2, "outfit tap: stop then say");
    assert.equal(l[0].call, "stop", "stop must be first (barge-in)");
    assert.equal(l[1].call, "say", "say must follow stop");
    assert.equal(l[1].text, say, "speaks the outfit's full say text");
    await ctx.close();
  } finally { await browser.close(); }
});

test("touch tap on a leaf tile speaks, stop BEFORE say (barge-in order)", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, { touch: true });
    await page.evaluate(() => window.Board.show("confirm_0")); // has speak leaves
    await resetLog(page);
    await page.locator(".tile.type-yes").first().tap();
    const l = await log(page);
    assert.equal(l.length, 2, "leaf tap: stop then say");
    assert.equal(l[0].call, "stop", "stop must be first (barge-in)");
    assert.equal(l[1].call, "say", "say must follow stop");
    assert.ok(l[1].text && l[1].text.length > 0, "leaf must speak non-empty text");
    await ctx.close();
  } finally { await browser.close(); }
});

test("gaze hover for the tile's hold fires dwell:activate exactly once", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser);
    // a content leaf (weather control) on the runtime dwellMs — the fast hold.
    const tile = page.locator(".tile.type-control").first();
    const ms = await tile.evaluate((el) => parseInt(el.dataset.dwellMs, 10));
    const c = await centerOf(tile);
    await settled(page);                       // let the mount's settle window expire
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(ms + 500);       // dwell should complete once
    const count = await page.evaluate(() => window.__activateCount);
    assert.equal(count, 1, "hovering past the hold fires exactly once");
    // and the activation obeyed barge-in: stop logged before say.
    const l = await log(page);
    assert.equal(l[0].call, "stop", "dwell activation stops first");
    await ctx.close();
  } finally { await browser.close(); }
});

test("brief hover (300ms) then leaving does NOT activate", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser);
    const tile = page.locator(".tile.type-outfit").first();
    const c = await centerOf(tile);
    await settled(page);                       // arm for real, or the glance is vacuous
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(300);            // well under any hold
    await page.mouse.move(5, 5);               // leave onto chrome (non-.dwell)
    await page.waitForTimeout(1400);           // let grace+decay run out
    const count = await page.evaluate(() => window.__activateCount);
    assert.equal(count, 0, "a 300ms glance must not activate");
    const l = await log(page);
    assert.deepEqual(l, [], "no activation -> no speech");
    await ctx.close();
  } finally { await browser.close(); }
});

test("tapping a nav door is SILENT; the bar carries the door and nothing else", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, { touch: true });
    // door: 'Build my own' category tile on the root board.
    await resetLog(page);
    await page.locator(".tile.type-category").first().tap();
    assert.deepEqual(await log(page), [{ call: "stop" }], "nav door: no say");

    // dad 9/2: "get rid of speak/clear we aren't using it." The bar is a slim
    // strip holding the exit door alone — no Speak, no Clear, no chips strip.
    const bar = await page.evaluate(() => {
      const b = document.querySelector(".msgbar");
      return {
        kids: [...b.children].map((el) => el.id || el.className),
        speak: !!document.querySelector("#barSpeak"),
        clear: !!document.querySelector("#barClear"),
        chips: !!document.querySelector(".chips"),
        hPct: +((b.getBoundingClientRect().height / innerHeight) * 100).toFixed(1),
      };
    });
    assert.ok(!bar.speak && !bar.clear, "no Speak/Clear button anywhere");
    assert.ok(!bar.chips, "no chips strip");
    assert.deepEqual(bar.kids, ["barDoor"], "the door is the bar's only child");
    // "the header is still too big" — the strip may not exceed 9% of the screen
    assert.ok(bar.hPct <= 9.1, `bar is a slim strip (was ${bar.hPct}% of the viewport)`);
    await ctx.close();
  } finally { await browser.close(); }
});

test("dwell onset delay: fill hidden for ~200ms, visible after (CSS-only)", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser);
    const tile = page.locator(".tile.type-outfit").first();
    const c = await centerOf(tile);
    await settled(page);                       // let the mount's settle window expire
    await page.mouse.move(c.x, c.y);           // begin hold -> fill element appears
    await page.waitForTimeout(110);
    const early = await page.evaluate(() => {
      const f = document.querySelector(".tile.dwell-active .dwell-fill");
      return f ? parseFloat(getComputedStyle(f).opacity) : null;
    });
    await page.waitForTimeout(280);            // now ~390ms in: past the 200ms delay
    const late = await page.evaluate(() => {
      const f = document.querySelector(".tile.dwell-active .dwell-fill");
      return f ? parseFloat(getComputedStyle(f).opacity) : null;
    });
    assert.ok(early !== null && late !== null, "fill element exists during a hold");
    assert.ok(early < 0.03, `fill invisible in first ~200ms (was ${early})`);
    assert.ok(late > 0.05, `fill visible after the onset delay (was ${late})`);
    await ctx.close();
  } finally { await browser.close(); }
});

test("msgbar door (top-left, D47): always armed, 2400ms hold, silent POST /app/exit", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, { touch: true });
    // The hub owns the exit (Settings: TD Snap or New ERA, dad 9/3) and talks
    // to ERAgaze itself. Intercept the hub's choke point so the wiring is
    // provable AND the "closed" path (no fallback navigation) is exercised.
    let exitHits = 0;
    await ctx.route("**/kiosk/exit", (r) => { exitHits++; r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"closed"}' }); });

    const door = page.locator("#barDoor");
    // placement + arming: leftmost bar element, always a live dwell target
    // (it is the only control in the bar since dad 9/2).
    const meta = await door.evaluate((el) => ({
      first: el.parentElement.firstElementChild === el,
      inBar: !!el.closest(".msgbar"),
      dwell: el.classList.contains("dwell"),
      ms: el.dataset.dwellMs,
      disabled: el.getAttribute("aria-disabled"),
      left: el.getBoundingClientRect().left,
      top: el.getBoundingClientRect().top,
    }));
    assert.ok(meta.inBar && meta.first, "door is the leftmost msgbar element");
    assert.equal(meta.ms, "2400", "door carries the exit hold (EC.holds.exit)");
    assert.ok(meta.dwell && meta.disabled !== "true", "door is armed with zero chips");
    assert.ok(meta.left < 200 && meta.top < 200, "door sits in the top-left corner");

    await resetLog(page);
    await door.tap();
    await page.waitForFunction(() => true); // flush microtasks
    await page.waitForTimeout(150);
    assert.equal(exitHits, 1, "door POSTs /kiosk/exit exactly once");
    assert.deepEqual(await log(page), [{ call: "stop" }], "door is silent (barge-in stop only)");
    // "closed" -> the hub is tearing the kiosk down; the page must NOT navigate.
    const alive = await page.evaluate(() => window.Board && window.__speechLog.length === 1);
    assert.ok(alive, "no fallback navigation on a closed exit");
    await ctx.close();
  } finally { await browser.close(); }
});

test("outfit pick telemetry: tile tap -> select event, Yes -> yes event (same combo)", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, { touch: true });
    // capture what the board would report (makePage already fulfills 204 so
    // nothing reaches the live server's history.json).
    const events = [];
    await ctx.route("**/outfit-event", (r) => {
      events.push(JSON.parse(r.request().postData()));
      r.fulfill({ status: 204, body: "" });
    });
    const tile = page.locator(".tile.type-outfit").first();
    await tile.tap(); // today page -> confirm board (say_on_load pick)
    await page.waitForTimeout(150);
    assert.equal(events.length, 1, "one event after the pick");
    assert.equal(events[0].kind, "select");
    assert.ok(Array.isArray(events[0].combo) && events[0].combo.length >= 1,
      "select carries the outfit's garment ids");
    const combo = events[0].combo;

    await page.locator(".tile.type-yes").first().tap();
    await page.waitForTimeout(150);
    assert.equal(events.length, 2, "Yes reports a second event");
    assert.equal(events[1].kind, "yes");
    assert.deepEqual(events[1].combo, combo, "yes carries the SAME combo as the pick");

    // nav doors and non-outfit leaves stay silent to telemetry
    await page.locator(".tile.type-back").first().tap();
    await page.waitForTimeout(150);
    assert.equal(events.length, 2, "back door reports nothing");
    await ctx.close();
  } finally { await browser.close(); }
});
