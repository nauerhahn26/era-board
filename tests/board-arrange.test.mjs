// board-arrange.test.mjs — "⇅ Arrange": a finger moves the songs (T4.5).
//
// The strip's second door (T4.4) hands arrange mode a cancelable
// `board:arrange` event; this suite pins what claiming it must cost:
//   * while arranging, NO tile is a gaze target any more — every one of them
//     drops .dwell and wears data-dwell-disabled, so a parked gaze cannot fire
//     the song a parent is in the middle of dragging. The door keeps its dwell:
//     the way out of the board is never taken away from her.
//   * a drag SWAPS two songs and posts the WHOLE running order to
//     /music/order — the hub refuses a partial list (music-add.js order()).
//   * the tile that was dragged never activates: no click, no navigation, no
//     music, and — the landmine this task exists for — dwell.js's 150ms
//     long-press tap-rescue (public/dwell.js scheduleRescue) never synthesizes
//     the click Windows owed us at the end of a drag.
//   * "✓ Done" gives the board back exactly as it was.
//   * arrange mode is unreachable by gaze, like the strip that opens it.
//
// Hermetic: /music/order is stubbed, so no test ever rewrites a manifest, and
// the page is served by the gate's hub (port re-pointed by era-gate.sh), so
// this suite holds no port of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/";
const QUIET_CLOTHING = { building: false, ingesting: null, photos: 3, cataloged: 3, aiConfigured: true };
const QUIET_CONTENT = { mode: "local", local: true, skipped: null, building: false, job: null,
                        queued: [], jobs: [], lastScan: null };
const IDLE_ADD = { pack: { id: "media-tools", installed: true }, folder: true, running: null, last: null };

// The gate's shelf: 12 fixture songs, so page 1 carries nine of them and the
// order posted back must name all twelve.
const ALL = Array.from({ length: 12 }, (_, i) => "test-song-" + (i + 1));

// A songs board with every hub route the page touches stubbed. `dial.order` is
// the answer /music/order gives; `orders` collects what arrange mode sent.
async function open(browser, dial) {
  const d = Object.assign({ order: { status: 200, body: { ok: true, songs: 12 } } }, dial || {});
  const orders = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true });
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/music-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/clothing/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CLOTHING) }));
  await ctx.route("**/content/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CONTENT) }));
  await ctx.route("**/music/add/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(IDLE_ADD) }));
  await ctx.route("**/music/order", (r) => {
    orders.push(r.request().postDataJSON());
    r.fulfill({ status: d.order.status, contentType: "application/json", body: JSON.stringify(d.order.body) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch {}
    // every way a tile could possibly fire, counted from the capture phase
    window.__activateCount = 0;
    window.__tileClicks = 0;
    window.__rescued = 0;
    window.__arrangeSaves = 0;
    // board-arrange.js says so on window when the hub has answered a move.
    window.addEventListener("board:arranged", () => { window.__arrangeSaves++; });
    document.addEventListener("dwell:activate", () => { window.__activateCount++; }, true);
    document.addEventListener("dwell:tap-rescued", () => { window.__rescued++; }, true);
    document.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest(".tile")) window.__tileClicks++;
    }, true);
    window.__boardTest = { statusMs: 60 * 60 * 1000, busyMs: 60 * 60 * 1000,
                           pollMs: 60 * 60 * 1000, idleMs: 60 * 60 * 1000, retryMs: 300,
                           addPollMs: 60 * 60 * 1000 };
  });
  await page.goto(BASE + "?recipe=songs", { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  await page.waitForSelector('.tile[data-arrange-id="test-song-1"]', { timeout: 8000 });
  return { ctx, page, orders, errors };
}

// the songs on the page, left to right and top to bottom — the same order the
// hub lays them out in (server.js SONG_CELLS_P1 is row-major).
const pageOrder = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".board-area .tile[data-arrange-id]")]
    .map((el) => ({
      id: el.dataset.arrangeId,
      r: +(el.style.gridRow || "1").split(" ")[0],
      c: +(el.style.gridColumn || "1").split(" ")[0],
    }))
    .sort((a, b) => a.r - b.r || a.c - b.c)
    .map((t) => t.id));

const centre = async (page, id) => {
  const b = await page.locator('.tile[data-arrange-id="' + id + '"]').boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

async function enterArrange(page) {
  await page.locator("#stripArrange").click();
  await page.waitForSelector("#arrangeNote", { timeout: 4000 });
}

// A REAL touch drag: Playwright's touchscreen only taps, so the raw CDP input
// domain drives the finger. These are trusted events, which is the whole point
// — dwell.js ignores anything that is not (public/dwell.js pointerdown).
async function touchDrag(client, from, to) {
  const pt = (p) => [{ x: p.x, y: p.y, radiusX: 12, radiusY: 12, force: 1 }];
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(from) });
  for (let i = 1; i <= 6; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6 };
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(p) });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("⇅ Arrange freezes the board: no tile is a gaze target, the door still is", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser);
    const before = await page.evaluate(() => ({
      tiles: document.querySelectorAll(".board-area .tile.dwell").length,
      note: !!document.getElementById("arrangeNote"),
    }));
    assert.ok(before.tiles > 0, "outside arrange mode her tiles are dwell targets");
    assert.equal(before.note, false, "and nothing is telling a grown-up to drag anything");

    await enterArrange(page);
    const on = await page.evaluate(() => ({
      dwellTiles: document.querySelectorAll(".board-area .tile.dwell").length,
      disabled: document.querySelectorAll(".board-area .tile[data-dwell-disabled]").length,
      tiles: document.querySelectorAll(".board-area .tile").length,
      doorDwell: !!document.querySelector(".bardoor.dwell"),
      arrangeLabel: document.getElementById("stripArrange").textContent.trim(),
      noteDwell: document.querySelectorAll("#arrangeNote .dwell").length,
    }));
    assert.equal(on.dwellTiles, 0, "arrange mode: not one tile is a dwell target");
    assert.equal(on.disabled, on.tiles, "every tile says so in the attribute dwell.js reads");
    assert.equal(on.doorDwell, true, "the way out of the board is never taken away");
    assert.equal(on.arrangeLabel, "✓ Done", "the strip button becomes the way out of arrange mode");
    assert.equal(on.noteDwell, 0, "the note is pointer-only too");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a drag swaps two songs and posts the WHOLE running order", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, orders, errors } = await open(browser);
    assert.deepEqual(await pageOrder(page), ALL.slice(0, 9), "page one is the first nine songs, in rank order");
    await enterArrange(page);
    const a = await centre(page, "test-song-1");
    const b = await centre(page, "test-song-2");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__arrangeSaves > 0, null, { timeout: 4000 });

    const want = ALL.slice();
    want[0] = "test-song-2"; want[1] = "test-song-1";
    assert.deepEqual(await pageOrder(page), want.slice(0, 9), "the two songs changed places on screen");
    assert.equal(orders.length, 1, "one POST /music/order");
    assert.deepEqual(orders[0], { ids: want }, "and it names every song the board knows, in the new order");
    await page.waitForFunction(() => /new order/i.test(document.getElementById("arrangeNote").textContent),
                               null, { timeout: 4000 });
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("the song that was dragged never activates — and dwell never rescues the tap", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser);
    const client = await ctx.newCDPSession(page);
    await enterArrange(page);
    const a = await centre(page, "test-song-1");
    const b = await centre(page, "test-song-3");
    await touchDrag(client, a, b);
    await page.waitForFunction(() => window.__arrangeSaves > 0, null, { timeout: 4000 });
    // the rescue fires 150ms after the release; wait past it and then some.
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      clicks: window.__tileClicks,
      rescued: window.__rescued,
      activated: window.__activateCount,
      board: window.Board.session.currentId,
      playing: window.Music ? window.Music.playingId() : null,
    }));
    assert.equal(after.clicks, 0, "no click ever reached a tile");
    assert.equal(after.rescued, 0, "dwell.js's long-press rescue never synthesized one either");
    assert.equal(after.activated, 0, "and no gaze fire happened");
    assert.equal(after.board, "songs", "the drag did not open the song it moved");
    assert.equal(after.playing, null, "and nothing started playing");

    // The landmine itself. A press that lets go WHERE IT STARTED is the exact
    // shape dwell.js rescues 150ms later (a slow finger; Windows' long-press
    // gesture eating the click) — a drag that ends on another tile is released
    // outside the first tile's halo and was never going to be rescued. In
    // arrange mode that rescued click would open the song under the finger, so
    // the tile must not be a .dwell target at all while a parent is arranging.
    const c = await centre(page, "test-song-4");
    await touchDrag(client, c, { x: c.x + 6, y: c.y + 6 });
    await page.waitForTimeout(400);
    const held = await page.evaluate(() => ({
      clicks: window.__tileClicks, rescued: window.__rescued, board: window.Board.session.currentId,
    }));
    assert.equal(held.rescued, 0, "a press that let go where it started is never rescued into a click");
    assert.equal(held.clicks, 0, "so no tile sees a click in arrange mode, synthetic or native");
    assert.equal(held.board, "songs", "and the board still has not moved");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("✓ Done hands the board back", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser);
    await enterArrange(page);
    await page.locator("#stripArrange").click();
    await page.waitForFunction(() => !document.getElementById("arrangeNote"), null, { timeout: 4000 });
    const off = await page.evaluate(() => ({
      dwellTiles: document.querySelectorAll(".board-area .tile.dwell").length,
      disabled: document.querySelectorAll(".board-area .tile[data-dwell-disabled]").length,
      label: document.getElementById("stripArrange").textContent.trim(),
    }));
    assert.ok(off.dwellTiles > 0, "her tiles are gaze targets again");
    assert.equal(off.disabled, 0, "and nothing is left switched off");
    assert.equal(off.label, "⇅ Arrange", "the strip button is a door back into arrange mode");
    // and a tap opens the song, exactly as it did before anyone arranged anything
    await page.locator('.tile[data-arrange-id="test-song-1"]').click();
    await page.waitForFunction(() => window.Board.session.currentId === "song-test-song-1", null, { timeout: 4000 });
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a gaze parked on ⇅ Arrange never opens arrange mode", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await open(browser);
    // ERAgaze drives the real cursor, so a parked gaze IS a parked pointer.
    const box = await page.locator("#stripArrange").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(2600);   // > the longest hold on the board (2400ms door)
    assert.equal(await page.locator("#arrangeNote").count(), 0, "arrange mode never opened itself");
    assert.equal(await page.evaluate(() => window.__activateCount), 0, "no dwell:activate on the strip");
    assert.equal(await page.locator(".dwell-active").count(), 0, "no dwell fill starts under the pointer");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a hub that refuses the new order says so in its own words, and the tiles go back", async () => {
  const browser = await chromium.launch();
  try {
    const refusal = { error: "incomplete",
                      message: "That order left songs out, so New ERA changed nothing. Reload the board and try again." };
    const { ctx, page, errors } = await open(browser, { order: { status: 400, body: refusal } });
    await enterArrange(page);
    const a = await centre(page, "test-song-1");
    const b = await centre(page, "test-song-2");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((want) => document.getElementById("arrangeNote").textContent.includes(want),
                               refusal.message, { timeout: 4000 });
    assert.deepEqual(await pageOrder(page), ALL.slice(0, 9), "a refused move is undone on screen too");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// Arrange mode used to swallow EVERY tap, which killed the "More" and "Back"
// doors — and a swap only ever exchanges two cells on the SAME page. A song
// added today lands at the end of the running order, i.e. on the last page, so
// page one was unreachable for it and a parent was left dragging at a wall
// (review 9/5). Page turns work while arranging, and a song dropped on a page
// door goes to the front of that page.
test("arrange mode turns the page, and a song can be sent to another one", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, orders, errors } = await open(browser);
    await enterArrange(page);

    await page.locator(".board-area .tile.type-control").click();   // "More"
    await page.waitForFunction(() => window.Board.session.currentId === "songs-2", null, { timeout: 4000 });
    assert.deepEqual(await pageOrder(page), ALL.slice(9), "page two: the songs page one had no room for");
    const still = await page.evaluate(() => ({
      dwellTiles: document.querySelectorAll(".board-area .tile.dwell").length,
      disabled: document.querySelectorAll(".board-area .tile[data-dwell-disabled]").length,
      tiles: document.querySelectorAll(".board-area .tile").length,
      note: !!document.getElementById("arrangeNote"),
    }));
    assert.equal(still.dwellTiles, 0, "the new page is asleep too: a page turn does not re-arm her tiles");
    assert.equal(still.disabled, still.tiles, "every tile on it says so in the attribute dwell.js reads");
    assert.equal(still.note, true, "and arrange mode is still on");

    const a = await centre(page, "test-song-10");
    const back = await page.locator(".board-area .tile.type-back").boundingBox();
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__arrangeSaves > 0, null, { timeout: 4000 });

    const want = ["test-song-10", ...ALL.filter((id) => id !== "test-song-10")];
    assert.equal(await page.evaluate(() => window.Board.session.currentId), "songs",
                 "the board follows the song it just sent, so a parent sees where it went");
    assert.deepEqual(await pageOrder(page), want.slice(0, 9), "and it is the first tile on page one");
    assert.equal(orders.length, 1, "one POST /music/order");
    assert.deepEqual(orders[0], { ids: want }, "naming every song the board knows, in the new order");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// The mirror is what carries the new order to the shelf the tiles are drawn
// from. When it does not land the hub says so (`mirrored:false`), and the note
// must not claim the board has already changed.
test("an order the shelf has not taken yet is reported as saved, not as done", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } =
      await open(browser, { order: { status: 200, body: { ok: true, songs: 12, mirrored: false } } });
    await enterArrange(page);
    const a = await centre(page, "test-song-1");
    const b = await centre(page, "test-song-2");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => /catch up/i.test(document.getElementById("arrangeNote").textContent),
                               null, { timeout: 4000 });
    const want = ALL.slice();
    want[0] = "test-song-2"; want[1] = "test-song-1";
    assert.deepEqual(await pageOrder(page), want.slice(0, 9), "the move was saved, so it stays on screen");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});
