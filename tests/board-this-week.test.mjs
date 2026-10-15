// board-this-week.test.mjs — the "This week" board, board side (spec 2026-10-12
// §3.3, plan C1). The hub builds /recipes/this-week.json from the week package
// on Drive (era-hub this-week.js); the board paints it: two doors on the root,
// a Watch grid whose READY videos are photo tiles that hand a /watch/ page to
// ERAgaze (POST 127.0.0.1:49155/app/launch) and whose not-yet-downloaded ones
// are plain "not here yet" words, and Talk pages of the week's words.
// The recipe is STUBBED at the network layer with exactly the hub's cell shapes
// (copied from era-hub tests/this-week-recipe.test.mjs). Fixture week 2026-01-05
// and fake 11-character ids only.
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
// video (mp4 + webp), one zero-byte mp4, one absent; ten words.
const FIXTURE = {
  locale: "en-US", root: "this-week",
  boards: [
    { id: "this-week", name: "Shadows!", rows: 3, columns: 4, buttons: [
      { type: "show", board: "watch", label: "Watch", say: "watch", glyph: "🎬", row: 1, col: 1,
        say_on_load: "This week: Shadows!" },
      { type: "show", board: "talk-1", label: "Talk", say: "talk", glyph: "💬", row: 1, col: 4 },
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

async function makePage(browser, { recipe = FIXTURE, launchStatus = 200, lock = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, hasTouch: true });
  const launches = [], logs = [];
  const state = { launchStatus };
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
  return { ctx, page, launches, logs, state, errors };
}
const ready = (page) => page.waitForFunction(
  () => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
const speech = (page) => page.evaluate(() => (window.__speechLog || []).slice());
const resetLog = (page) => page.evaluate(() => { window.__speechLog.length = 0; });
const onBoard = (page) => page.evaluate(() => window.Board.session.currentId);
const twLogs = (logs) => logs.filter((l) => l && l.app === "this-week");

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

test("this week: two doors, the title spoken, Watch launches a downloaded video", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches, logs, errors } = await makePage(browser);
    await ready(page);
    assert.equal(await onBoard(page), "this-week");
    // ---- root: two doors and nothing else ----
    assert.equal(await page.locator(".board-area .tile").count(), 2, "two doors");
    assert.equal(await page.locator('.tile:has-text("Watch")').count(), 1);
    assert.equal(await page.locator('.tile:has-text("Talk")').count(), 1);
    assert.equal(await page.locator(".cell.rest").count(), 10, "everything else black");
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

    // a not-here-yet tile is a word: it says so, launches nothing
    await resetLog(page);
    await notYet.first().click();
    assert.deepEqual((await speech(page)).filter((e) => e.call === "say").map((e) => e.text), ["not here yet"]);
    assert.equal(launches.length, 0);

    // ---- the launch ----
    await vid.click();
    await page.waitForSelector(".tile.type-video.watching", { timeout: 4000 });
    assert.equal(launches.length, 1, "one launch POST");
    assert.deepEqual(launches[0], { url: `${ORIGIN}/watch/?w=${WEEK}&v=${A}`, watch: true },
      "the engine gets the watch page, nothing else");
    for (let i = 0; i < 40 && !twLogs(logs).length; i++) await page.waitForTimeout(50);
    assert.deepEqual(twLogs(logs), [{ app: "this-week", door: "watch", week_of: WEEK, id: A, event: "launch" }],
      "one launch line to /log");
    // the marker survives page nav
    await page.locator(".tile.type-back").click();
    assert.equal(await onBoard(page), "this-week", "Back -> root");
    await page.locator('.tile:has-text("Watch")').click();
    assert.equal(await page.locator(".tile.type-video.watching").count(), 1, "marker re-applied");
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); }
});

test("this week: the engine refusing -> launch-failed flag + the generic banner, no marker, no log", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, logs } = await makePage(browser, { launchStatus: 500 });
    await ready(page);
    await page.evaluate(() => window.Board.show("watch"));
    await page.locator(".tile.type-video").click();
    await page.waitForSelector(".tile.type-video.launch-failed", { timeout: 4000 });
    assert.ok(await page.locator("#launchWarn").isVisible(), "the banner shows");
    const text = await page.locator("#launchWarn").textContent();
    assert.ok(/Not now/.test(text) && !/Movies/.test(text), "the banner is generic: " + text);
    assert.equal(await page.locator(".tile.watching").count(), 0, "no marker on a refusal");
    assert.deepEqual(twLogs(logs), [], "no launch line on a refusal");
    await ctx.close();
  } finally { await browser.close(); }
});

test("this week: the media lock takes the video too — the look posts nothing", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches, logs } = await makePage(browser, { lock: { until: 0 } });
    await ready(page);
    await page.evaluate(() => window.Board.show("watch"));
    const vid = page.locator(".tile.type-video");
    assert.equal(await vid.evaluate((el) => el.classList.contains("dwell")), false,
      "a locked video is no gaze target");
    await vid.click();
    await page.waitForTimeout(400);
    assert.equal(launches.length, 0, "locked: nothing launched");
    assert.deepEqual(twLogs(logs), []);
    // the words are not media: "not here yet" still speaks
    assert.ok(await page.locator('.tile.type-word:has-text("Shadow video 2")').evaluate((el) => el.classList.contains("dwell")));
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
