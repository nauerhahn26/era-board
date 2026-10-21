// board-this-week.test.mjs — the "This week" board, board side (spec 2026-10-12
// §3.3 amended 10/21, §5.6; plan phase 2 D1). The hub builds
// /recipes/this-week.json from the week package on Drive (era-hub
// this-week.js); the board paints it: three doors on the root (Watch, Talk and
// the Play `link`), a Watch grid whose READY videos are photo tiles that take
// THIS window to the hub's /watch/ page (no ERAgaze launch: on 10/13 the old
// launch fired four times in four seconds) and whose not-yet-downloaded ones
// are plain "not here yet" words, and Talk pages of the week's words.
// The recipe is STUBBED at the network layer with exactly the hub's cell shapes
// (copied from era-hub tests/this-week-recipe.test.mjs), and so are the two
// pages a tile navigates to (/watch/, /play/) — this suite tests the board.
// Fixture week 2026-01-05 and fake 11-character ids only.
// Runs under `node --test` or `node tests/board-this-week.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const CONTRACT = await (async () => {
  for (const p of ["../public/lib/contract.js", "../../era-core/lib/contract.js"]) {
    try { return (await import(new URL(p, import.meta.url))).CONTRACT; } catch { /* next */ }
  }
  throw new Error("lib/contract.js not found from " + import.meta.url);
})();
const GAP_FLOOR = CONTRACT.sizes.gapFloor;

const BASE = "http://localhost:8377/board/?recipe=this-week";
const ORIGIN = new URL(BASE).origin;
const WEEK = "2026-01-05";
const A = "aBcDeFgHiJk";

const back = (load = "this-week") =>
  ({ label: "Back", say: "back", type: "back", glyph: "←", load, row: 1, col: 1 });
const word = (w, row, col, g = {}) => ({ type: "word", label: w, say: w, ...g, row, col });

// EXACTLY what era-hub this-week.js builds for the B1 fixture week: one ready
// video (mp4 + webp), one zero-byte mp4, one absent; ten words; and (phase 2,
// THIS_WEEK_REV 2) the Play door at [3,4] because the week has play content.
const FIXTURE = {
  locale: "en-US", root: "this-week",
  boards: [
    { id: "this-week", name: "Shadows!", rows: 3, columns: 4, buttons: [
      { type: "show", board: "watch", label: "Watch", say: "watch", glyph: "🎬", row: 1, col: 1,
        say_on_load: "This week: Shadows!" },
      { type: "show", board: "talk-1", label: "Talk", say: "talk", glyph: "💬", row: 1, col: 4 },
      { type: "link", href: `/play/?w=${WEEK}`, label: "Play", say: "play", glyph: "🎲", row: 3, col: 4 },
    ] },
    { id: "watch", name: "Shadows!", rows: 3, columns: 4, buttons: [
      back(),
      { type: "video", id: A, week_of: WEEK, label: "Shadow video 1",
        image: `this-week/${WEEK}/${A}.webp`, row: 1, col: 2 },
      { type: "word", label: "Shadow video 2", say: "not here yet", glyph: "⏳", row: 1, col: 3 },
      { type: "word", label: "Shadow video 3", say: "not here yet", glyph: "⏳", row: 1, col: 4 },
    ] },
    { id: "talk-1", name: "Shadows!", rows: 3, columns: 4, buttons: [
      back(),
      word("shadow", 1, 2, { glyph: "🌑" }), word("light", 1, 3, { glyph: "💡" }),
      word("sun", 1, 4, { glyph: "☀️" }), word("lamp", 2, 1, { glyph: "🪔" }),
      word("dark", 2, 4, { glyph: "🌚" }), word("big", 3, 2, { glyph: "🐘" }),
      word("small", 3, 3, { glyph: "🐜" }), word("more", 3, 4, { symbol: "more" }),
      { label: "More", type: "control", symbol: "more", load: "talk-2", row: 3, col: 1 },
    ] },
    { id: "talk-2", name: "Shadows!", rows: 3, columns: 4, buttons: [
      back(),
      word("help", 1, 2, { symbol: "help" }), word("go", 1, 3, { symbol: "go" }),
    ] },
  ],
};
// no week on disk: the hub answers a valid board with the root only, no buttons
const EMPTY = { locale: "en-US", root: "this-week",
  boards: [{ id: "this-week", name: "This week", rows: 3, columns: 4, buttons: [] }] };

// 1x1 PNG, served for the thumbnail (the real /this-week/ jail is the hub's)
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");

// the two pages a tile may take the window to, stubbed: every request is
// recorded, and `state.hold` (a promise) keeps the old page standing while the
// navigation is in flight — the window in which a parked gaze could re-fire.
const STUB_PAGE = "<!doctype html><meta charset=utf-8><title>stub</title><p>stub page</p>";

async function makePage(browser, { recipe = FIXTURE, launchStatus = 200, lock = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, hasTouch: true });
  const launches = [], logs = [], navs = [];
  const state = { launchStatus, hold: null };
  for (const pat of ["**/play/*", "**/watch/*"]) {
    await ctx.route(pat, async (r) => {
      navs.push(r.request().url());
      if (state.hold) await state.hold;
      r.fulfill({ status: 200, contentType: "text/html", body: STUB_PAGE });
    });
  }
  await ctx.route("**/log", (r) => {
    try { logs.push(r.request().postDataJSON()); } catch { /* not json */ }
    r.fulfill({ status: 204, body: "" });
  });
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/this-week/" + WEEK + "/*", (r) =>
    r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await ctx.route("**/recipes/this-week.json", (r) => {
    const headers = { "Content-Type": "application/json", "ETag": '"tw-fixture-1"', "Cache-Control": "no-cache" };
    if (r.request().method() === "HEAD") { r.fulfill({ status: 200, headers, body: "" }); return; }
    r.fulfill({ status: 200, headers, body: JSON.stringify(recipe) });
  });
  await ctx.route("http://127.0.0.1:49155/app/launch", (r) => {
    launches.push(r.request().postDataJSON());
    r.fulfill({ status: state.launchStatus, body: "" });
  });
  await ctx.addInitScript((seed) => {
    try { localStorage.clear(); } catch {}
    if (seed) { try { localStorage.setItem("era.lock", JSON.stringify(seed)); } catch {} }
    window.__testHooks = true;
    window.__boardTest = { statusMs: 3600000, busyMs: 3600000, pollMs: 3600000,
                           idleMs: 3600000, retryMs: 300, reload: () => {} };
  }, lock);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "load" });
  return { ctx, page, launches, logs, navs, state, errors };
}
const ready = (page) => page.waitForFunction(
  () => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
const speech = (page) => page.evaluate(() => (window.__speechLog || []).slice());
const resetLog = (page) => page.evaluate(() => { window.__speechLog.length = 0; });
const onBoard = (page) => page.evaluate(() => window.Board.session.currentId);
const twLogs = (logs) => logs.filter((l) => l && l.app === "this-week");
// a GAZE dwell: ERAgaze drives the real cursor, so a parked gaze is a parked
// pointer. Wait out the page-settle window first (board-input.test.mjs explains
// why a lone synthetic move inside it is swallowed), then park on the tile.
const settled = (page) => page.waitForFunction(
  () => window.Dwell && window.Dwell.state().suppressedMs === 0, null, { timeout: 4000 });
async function dwellOn(page, loc) {
  await settled(page);
  const b = await loc.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}
const PLAY_URL = new RegExp(`/play/\\?w=${WEEK}$`);
const WATCH_URL = new RegExp(`/watch/\\?w=${WEEK}&v=${A}$`);

// the floors, asserted directly (board-pixel's MEASURE is not exported):
// every grid .dwell >= 90 px each way at 1920, no third thing in the bar, gaps at
// the contract floor, nothing offscreen, no horizontal scroll.
async function floors(page, tag) {
  const m = await page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const rects = [...document.querySelectorAll(".dwell")].filter(vis).map((el) => ({
      el, r: el.getBoundingClientRect(), n: el.id || el.getAttribute("aria-label") || String(el.className) }));
    // the 90 px floor is the GRID's; the bar's doors are sized by the slim-bar
    // law (<= 9 % of the screen, board-pixel BAR_TOO_TALL), not by this one
    const small = rects.filter(({ el, r }) => el.closest(".board-area") && (r.width < 90 || r.height < 90))
      .map(({ r, n }) => ({ n, w: Math.round(r.width), h: Math.round(r.height) }));
    let minGap = Infinity;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      const dx = Math.max(a.left - b.right, b.left - a.right), dy = Math.max(a.top - b.bottom, b.top - a.bottom);
      const d = (dx < 0 && dy < 0) ? Math.max(dx, dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      minGap = Math.min(minGap, d);
    }
    const off = rects.filter(({ r }) => r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5).map((x) => x.n);
    const bar = document.querySelector(".msgbar");
    const barExtras = bar ? [...bar.children].map((el) => el.id || String(el.className))
      .filter((n) => n !== "barDoor" && n !== "barTalk") : ["NO BAR"];
    const tiles = [...document.querySelectorAll(".board-area .tile")].map((el) => {
      const r = el.getBoundingClientRect(); return { n: el.getAttribute("aria-label"), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return { small, minGap, off, barExtras, tiles,
      hscroll: document.documentElement.scrollWidth > vw + 1 };
  });
  console.log(`[${tag}] tiles ${JSON.stringify(m.tiles)} minGap=${m.minGap}`);
  assert.deepEqual(m.small, [], `${tag}: every .dwell >= 90 px`);
  assert.ok(m.minGap >= GAP_FLOOR - 0.5, `${tag}: min gap ${m.minGap} >= ${GAP_FLOOR}`);
  assert.deepEqual(m.off, [], `${tag}: nothing offscreen`);
  assert.deepEqual(m.barExtras, [], `${tag}: the bar holds only the doors`);
  assert.equal(m.hscroll, false, `${tag}: no horizontal scroll`);
  return m;
}

test("this week: three doors, the title spoken, Watch takes this window to the watch page", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches, logs, navs, state, errors } = await makePage(browser);
    await ready(page);
    assert.equal(await onBoard(page), "this-week");
    // ---- root: three doors in their seats and nothing else ----
    assert.equal(await page.locator(".board-area .tile").count(), 3, "three doors");
    const seat = (label) => page.locator(`.board-area .tile:has-text("${label}")`).evaluate((el) =>
      [el.style.gridRow, el.style.gridColumn].join(","));
    assert.equal(await seat("Watch"), "1,1", "Watch at [1,1]");
    assert.equal(await seat("Talk"), "1,4", "Talk at [1,4]");
    assert.equal(await seat("Play"), "3,4", "Play at [3,4]");
    const play = page.locator(".board-area .tile.type-link");
    assert.equal(await play.count(), 1, "Play is a link tile");
    assert.ok(await play.evaluate((el) => el.classList.contains("glyph") && el.classList.contains("dwell")),
      "painted like a door: big glyph + label, a gaze target");
    assert.equal(await play.locator(".tile-glyph").textContent(), "🎲");
    assert.equal(await page.locator(".cell.rest").count(), 9, "everything else black");
    await page.waitForFunction(() => (window.__speechLog || []).some((e) => e.call === "say"), null, { timeout: 4000 });
    assert.deepEqual((await speech(page)).filter((e) => e.call === "say").map((e) => e.text),
      ["This week: Shadows!"], "the root voices the week's title once");
    await floors(page, "root");

    // ---- Watch ----
    await page.locator('.tile:has-text("Watch")').click();
    assert.equal(await onBoard(page), "watch");
    const vid = page.locator(".tile.type-video");
    assert.equal(await vid.count(), 1, "one ready video");
    assert.ok(await vid.evaluate((el) => el.classList.contains("photo")), "video rides the photo path");
    assert.ok((await vid.locator("img.photo-img").getAttribute("src")).endsWith(`/this-week/${WEEK}/${A}.webp`),
      "thumbnail from the week folder");
    assert.equal(await vid.locator(".tile-label.plate").textContent(), "Shadow video 1");
    const notYet = page.locator('.tile.type-word:has-text("Shadow video")');
    assert.equal(await notYet.count(), 2, "two not-here-yet words");
    const m = await floors(page, "watch");
    assert.equal(m.tiles.length, 4);

    // a not-here-yet tile is a word: it says so, goes nowhere
    await resetLog(page);
    await notYet.first().click();
    assert.deepEqual((await speech(page)).filter((e) => e.call === "say").map((e) => e.text), ["not here yet"]);
    assert.equal(launches.length, 0);
    assert.equal(navs.length, 0);

    // ---- a gaze dwell on the video: the SAME window goes to /watch/ ----
    // The navigation is held open for 2.5 s with the pointer still parked on
    // the tile — longer than two of her dwells — so a re-firing tile would
    // show up here as a second request (10/13: four launches in four seconds).
    // Playwright's page calls wait for a pending navigation, so the old page
    // reports what happens to it through a binding instead of being asked.
    const marks = [];
    await page.exposeFunction("__twMark", (m) => { marks.push(m); });
    await vid.evaluate((tile) => {
      new MutationObserver(() => {
        if (tile.hasAttribute("data-dwell-disabled")) window.__twMark("disabled");
        if (document.querySelector(".watching")) window.__twMark("watching");
      }).observe(document.querySelector(".board-area"), { subtree: true, attributes: true });
    });
    let release; state.hold = new Promise((res) => { release = res; });
    await dwellOn(page, vid);
    for (let i = 0; i < 80 && !navs.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(navs.length, 1, "the dwell asked for the watch page");
    assert.ok(WATCH_URL.test(navs[0]), "the watch page for this week and id: " + navs[0]);
    for (let i = 0; i < 20 && !marks.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(marks.includes("disabled"), "the leaving tile is no longer a gaze target");
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!marks.includes("watching"), "no .watching marker: " + JSON.stringify(marks));
    assert.equal(navs.length, 1, "the parked gaze never fired a second time");
    release(); state.hold = null;
    await page.waitForURL(WATCH_URL, { timeout: 5000 });
    assert.equal(launches.length, 0, "nothing posted to the gaze engine");
    assert.deepEqual(twLogs(logs), [], "the board logs nothing (the watch page logs open)");
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); }
});

test("this week: a dwell on Play takes this window to the Play app", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches, navs, errors } = await makePage(browser);
    await ready(page);
    await dwellOn(page, page.locator(".board-area .tile.type-link"));
    await page.waitForURL(PLAY_URL, { timeout: 5000 });
    assert.equal(navs.length, 1, "one navigation");
    assert.equal(launches.length, 0, "nothing posted to the gaze engine");
    assert.equal(await page.locator(".watching").count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); }
});

// tiles a recipe must never be able to aim off this hub or at a forged path:
// every one is PAINTED (the recipe is trusted to draw) but inert
const BAD = { locale: "en-US", root: "this-week",
  boards: [{ id: "this-week", name: "Shadows!", rows: 3, columns: 4, buttons: [
    { type: "link", href: "http://evil", label: "a", glyph: "🎲", row: 1, col: 1 },
    { type: "link", href: "//x", label: "b", glyph: "🎲", row: 1, col: 2 },
    { type: "link", href: "/\\x", label: "c", glyph: "🎲", row: 1, col: 3 },
    { type: "link", href: "/play/ x", label: "d", glyph: "🎲", row: 1, col: 4 },
    { type: "link", href: "/play/<x>", label: "e", glyph: "🎲", row: 2, col: 1 },
    { type: "link", href: "javascript:alert(1)", label: "f", glyph: "🎲", row: 2, col: 4 },
    { type: "link", label: "g", glyph: "🎲", row: 3, col: 1 },
    { type: "video", id: "../../x/aaaa", week_of: WEEK, label: "h", row: 3, col: 2 },
    { type: "video", id: A, week_of: "2026-1-05", label: "i", row: 3, col: 3 },
    { type: "video", id: A + "&x=1", week_of: WEEK, label: "j", row: 3, col: 4 },
  ] }] };

test("this week: a link off this hub, or a forged video, is painted but inert", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches, navs, errors } = await makePage(browser, { recipe: BAD });
    await ready(page);
    const before = page.url();
    let frames = 0;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) frames++; });
    const tiles = page.locator(".board-area .tile");
    assert.equal(await tiles.count(), 10, "every bad tile still paints");
    for (let i = 0; i < 10; i++) await tiles.nth(i).click();
    await page.waitForTimeout(600);
    assert.equal(page.url(), before, "the window never left the board");
    assert.equal(frames, 0, "no navigation at all");
    assert.equal(navs.length, 0);
    assert.equal(launches.length, 0, "nothing posted to the gaze engine");
    assert.equal(await page.locator(".watching").count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); }
});

test("this week: the media lock takes the video, not the Play door", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches, logs, navs } = await makePage(browser, { lock: { until: 0 } });
    await ready(page);
    // the Play door is not media: still a gaze target under the lock
    assert.ok(await page.locator(".board-area .tile.type-link").evaluate((el) =>
      el.classList.contains("dwell") && !el.hasAttribute("data-dwell-disabled")), "Play is not locked");
    await page.evaluate(() => window.Board.show("watch"));
    const vid = page.locator(".tile.type-video");
    assert.equal(await vid.evaluate((el) => el.classList.contains("dwell")), false,
      "a locked video is no gaze target");
    await vid.click();                         // a finger still lands a click
    await page.waitForTimeout(400);
    assert.equal(navs.length, 0, "locked: the video goes nowhere");
    assert.equal(launches.length, 0, "locked: nothing launched");
    assert.deepEqual(twLogs(logs), []);
    // the words are not media: "not here yet" still speaks
    assert.ok(await page.locator('.tile.type-word:has-text("Shadow video 2")').evaluate((el) => el.classList.contains("dwell")));
    // and the Play door still navigates under the lock
    await page.locator(".tile.type-back").click();
    assert.equal(await onBoard(page), "this-week");
    await dwellOn(page, page.locator(".board-area .tile.type-link"));
    await page.waitForURL(PLAY_URL, { timeout: 5000 });
    assert.equal(navs.length, 1);
    await ctx.close();
  } finally { await browser.close(); }
});

test("this week: Talk speaks, More -> talk-2, Back -> root", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser);
    await ready(page);
    await page.locator('.tile:has-text("Talk")').click();
    assert.equal(await onBoard(page), "talk-1");
    assert.equal(await page.locator(".board-area .tile.type-word").count(), 8, "8 words");
    await floors(page, "talk-1");
    await resetLog(page);
    await page.locator('.tile.type-word:has-text("shadow")').click();
    assert.deepEqual(await speech(page), [{ call: "stop" }, { call: "say", text: "shadow" }]);
    await page.locator('.tile.type-control:has-text("More")').click();
    assert.equal(await onBoard(page), "talk-2");
    assert.equal(await page.locator(".board-area .tile.type-word").count(), 2);
    await page.locator(".tile.type-back").click();
    assert.equal(await onBoard(page), "this-week", "Back from the last page -> root");
    await ctx.close();
  } finally { await browser.close(); }
});

test("this week: no week on the hub -> the splash says so", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, { recipe: EMPTY });
    await page.waitForSelector(".splash", { timeout: 8000 });
    await page.waitForFunction(() => /Nothing this week yet/.test(document.querySelector(".splash").textContent),
      null, { timeout: 4000 });
    assert.equal(await page.locator(".board-area .tile").count(), 0);
    await ctx.close();
  } finally { await browser.close(); }
});
