// board-edit.test.mjs — the hold-to-edit sheet (T8/T9, spec 2026-09-17 §4.2).
//
// Dad 9/17: "the touch-only long touch could allow modifications." The model
// files a hoodie as a top; a grown-up holds that tile for 1.6 s, taps the
// Jacket chip, taps Done, and the hoodie leaves the outfits and appears on the
// Jackets grid. Nothing about her board changes for anyone who is not holding.
//
// So this suite pins the price of the gesture the way board-lock.test.mjs pinned
// the lock's:
//   * it answers a FINGER and nothing else — a mouse held for two seconds is a
//     parked GAZE at the DOM (ERAgaze drives the real cursor), and a sheet she
//     could open by looking at her own clothes is not a grown-up control;
//   * a press that is let go before the hold is over does NOTHING — it does not
//     open the sheet, and it does not fall through to the tap either: no
//     /outfit-event, no navigation, not a word spoken. That second half is the
//     dwell.js TAP-RESCUE, which fires el.click() 150 ms after a long touch
//     release and would otherwise send her to the confirm page every time a
//     grown-up gave up on a hold;
//   * a QUICK tap still works, because this is her board first (board-input's
//     "touch tap on an outfit tile navigates AND speaks" runs over these very
//     tiles once the hub stamps `items` on them);
//   * once open, the sheet is a grown-up surface on HER screen: no .dwell, no
//     data-dwell-*, the board underneath asleep, and both DOORS still hers;
//   * Done posts only what CHANGED, and waits for the hub's rebuild before it
//     reloads; Cancel posts nothing; a 400 keeps the sheet and says the hub's
//     own sentence.
//
// HOW THE HOLD IS DRIVEN: page.touchscreen can only TAP, so a 1600 ms finger is
// dispatched over CDP (Input.dispatchTouchEvent) exactly as board-lock.test.mjs
// does — real trusted pointer events with pointerType "touch", the one thing
// board-edit.js filters on.
//
// Hermetic: every hub route the board touches is stubbed, including
// /clothing/item and the /recipes/today.json ETag the rebuild flips. The page
// itself is served by the gate's hub (port re-pointed by era-gate.sh), so this
// suite holds no port of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/";
const QUIET_CLOTHING = { building: false, ingesting: null, photos: 3, cataloged: 3, aiConfigured: true };
const QUIET_CONTENT = { mode: "local", local: true, skipped: null, building: false, job: null,
                        queued: [], jobs: [], lastScan: null };

const JPG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64");

// The hub's T5 shape: the category list lives at the recipe ROOT (garments
// first, then the accessory kinds) so the chips are the hub's list and the
// board never carries one of its own to drift.
const HOODIE = { id: "item_h", name: "Grey hoodie", category: "top", occasion: "everyday" };
const LEGGINGS = { id: "item_b", name: "Pink leggings", category: "pants", occasion: "everyday" };

const FIXTURE = {
  locale: "en-US", root: "today", home_label: "Clothing",
  categories: [
    { id: "top", label: "Top" }, { id: "pants", label: "Pants" },
    { id: "shorts", label: "Shorts" }, { id: "dress", label: "Dress" },
    { id: "set", label: "Outfit" }, { id: "jacket", label: "Jacket" },
    { id: "shoes", label: "Shoes" }, { id: "jewelry", label: "Jewelry" },
    { id: "hat", label: "Hat" }, { id: "hair", label: "Hair" },
    { id: "makeup", label: "Makeup" },
  ],
  boards: [
    { id: "today", name: "What will I wear today?", rows: 3, columns: 4,
      buttons: [
        { label: "62°  cool", type: "control", symbol: "sun",
          say: "Today it is cool.", row: 1, col: 1 },
        // the outfit tile: TWO garments under one finger, and the one tile on
        // the board whose tap both speaks and navigates (say_on_load)
        { label: "Hoodie + leggings", say: "Grey hoodie and pink leggings",
          type: "outfit", image: "wardrobe-outfits/outfit_0.jpg", row: 1, col: 2,
          load: "confirm_0", say_on_load: true, combo: ["item_h", "item_b"],
          items: [HOODIE, LEGGINGS] },
        { label: "Accessories", type: "category", symbol: "clothes", load: "acc", row: 3, col: 3 },
        { label: "Build my own", type: "category", symbol: "clothes", load: "cat_top", row: 3, col: 4 },
      ] },
    { id: "confirm_0", name: "This one?", rows: 3, columns: 2,
      buttons: [
        { label: "Hoodie + leggings", say: "Grey hoodie and pink leggings",
          type: "outfit", image: "wardrobe-outfits/outfit_0.jpg",
          combo: ["item_h", "item_b"], items: [HOODIE, LEGGINGS] },
        { label: "Yes", type: "yes", symbol: "yes", say: "Yes", combo: ["item_h", "item_b"] },
        { label: "Back", type: "back", glyph: "←", load: "today" },
      ] },
    { id: "cat_top", name: "Tops", rows: 3, columns: 4,
      buttons: [
        { label: "Back", type: "back", glyph: "←", load: "today", row: 1, col: 1 },
        // ONE garment: the hoodie the model mis-filed as a top
        { label: "Grey hoodie", say: "Grey hoodie", type: "clothing",
          image: "wardrobe-items/item_h.jpg", row: 1, col: 2, items: [HOODIE] },
      ] },
    { id: "acc", name: "Accessories", rows: 3, columns: 4,
      buttons: [{ label: "Back", type: "back", glyph: "←", load: "today", row: 1, col: 1 }] },
  ],
};

// One board page with every hub route stubbed. `dial.item` is what
// POST /clothing/item answers; `posts` collects the bodies; `recipeGets`
// counts the GETs (a reload is a second one).
async function open(browser, dial) {
  const d = Object.assign({ item: { status: 200, body: { ok: true, builds: true } } }, dial || {});
  const posts = [];
  const recipeGets = [];
  const outfitEvents = [];
  let etag = '"edit-1"';
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true });
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/symbol/*", (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: JPG }));
  await ctx.route(/\/(wardrobe-outfits|wardrobe-items|clothing-web)\/.*\.jpg$/, (r) =>
    r.fulfill({ status: 200, contentType: "image/jpeg", body: JPG }));
  await ctx.route("**/settings", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ dwellMs: 1200, settleMs: 250, exitTo: "home" }) }));
  await ctx.route("**/clothing/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CLOTHING) }));
  await ctx.route("**/content/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CONTENT) }));
  await ctx.route("**/music/add/status", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ pack: { id: "media-tools", installed: true }, folder: true, running: null, last: null }) }));
  await ctx.route("**/outfit-event", (r) => {
    outfitEvents.push(r.request().postDataJSON());
    r.fulfill({ status: 204, body: "" });
  });
  // the hub's edit route. A 2xx ALSO flips the recipe's ETag — that is the
  // rebuild the sheet is waiting for, and the only thing that may reload her
  // board.
  await ctx.route("**/clothing/item", (r) => {
    posts.push(r.request().postDataJSON());
    if (d.item.status === 200) etag = '"edit-2"';
    r.fulfill({ status: d.item.status, contentType: "application/json",
                body: JSON.stringify(d.item.body) });
  });
  await ctx.route("**/recipes/today.json", (r) => {
    const headers = { "Content-Type": "application/json", "ETag": etag, "Cache-Control": "no-cache" };
    if (r.request().method() === "HEAD") { r.fulfill({ status: 200, headers, body: "" }); return; }
    recipeGets.push(etag);
    r.fulfill({ status: 200, headers, body: JSON.stringify(FIXTURE) });
  });
  await ctx.route("http://127.0.0.1:49155/**", (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch {}
    window.__testHooks = true;                    // arm board.js's Speech spy
    window.__activateCount = 0;
    document.addEventListener("dwell:activate", () => { window.__activateCount++; }, true);
    // the watcher must never reload on its own: only the sheet may.
    window.__boardTest = { statusMs: 60 * 60 * 1000, busyMs: 60 * 60 * 1000,
                           pollMs: 60 * 60 * 1000, idleMs: 60 * 60 * 1000,
                           retryMs: 60 * 60 * 1000 };
    // the sheet's own poll, sped up so a rebuild is not a minute of test time
    window.__editTest = { pollMs: 200, waitMs: 8000 };
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  await page.waitForFunction(() => window.__editTest && typeof window.__editTest.open === "function", null, { timeout: 8000 });
  return { ctx, page, posts, recipeGets, outfitEvents, errors };
}

// A real finger on a real element, held for `ms`. CDP, not page.touchscreen:
// the latter only taps. touchStart -> pointerdown{pointerType:"touch"} in the
// page, which is precisely what board-edit.js filters on.
// `midway` gets the same CDP session and the finger's start point, so a test
// can move the finger that is already down.
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

const TILE = '.board-area .tile[data-items="item_h,item_b"]';      // the outfit tile
const GARMENT = '.board-area .tile[data-items="item_h"]';          // one garment on cat_top

const boardState = (page) => page.evaluate(() => {
  const tiles = [...document.querySelectorAll(".board-area .tile")];
  const doors = [...document.querySelectorAll(".msgbar .dwell")].map((el) => el.id);
  return {
    sheet: !!document.getElementById("editSheet"),
    rows: document.querySelectorAll("#editSheet .edit-row").length,
    tiles: tiles.length,
    asleep: tiles.filter((el) => !el.classList.contains("dwell") &&
      el.hasAttribute("data-dwell-disabled")).length,
    awake: tiles.filter((el) => el.classList.contains("dwell")).length,
    doors,
    board: window.Board.session.currentId,
    speech: (window.__speechLog || []).slice(),
  };
});

// ------------------------------------------------------- who may open the sheet

test("a mouse held for two seconds opens nothing: gaze is a mouse here", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser);
    const box = await page.locator(TILE).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(2200);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const s = await boardState(page);
    assert.equal(s.sheet, false, "a parked gaze cannot open a grown-up's sheet");
    assert.equal(s.awake, s.tiles, "and no tile was ever disarmed");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a 1600ms finger on an outfit tile opens the sheet with BOTH garments", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, outfitEvents, errors } = await open(browser);
    const before = await boardState(page);
    assert.ok(before.tiles > 0 && before.awake === before.tiles, "the board starts hers");

    let ring = null;
    await hold(page, TILE, 2000, async () => {
      ring = await page.evaluate((sel) => {
        const t = document.querySelector(sel);
        return { holding: t.classList.contains("holding"),
                 holdMs: t.style.getPropertyValue("--hold-ms").trim(),
                 dwell: t.classList.contains("dwell"),
                 off: t.hasAttribute("data-dwell-disabled") };
      }, TILE);
    });
    assert.equal(ring.holding, true, "the fill ring runs while the finger is down");
    assert.equal(ring.holdMs, (await page.evaluate(() => window.__editTest.holdMs)) + "ms",
      "timed to the module's own hold, not a number in the stylesheet");
    assert.equal(ring.dwell, false, "the tile leaves gaze's reach the moment it is armed");
    assert.equal(ring.off, true, "…by BOTH halves, so dwell.js's tap-rescue cannot fire it either");

    await page.locator("#editSheet").waitFor({ timeout: 4000 });
    const s = await boardState(page);
    assert.equal(s.rows, 2, "one row per garment under the finger");
    assert.equal(s.board, "today", "and the hold never turned into a pick");
    assert.deepEqual(outfitEvents, [], "no /outfit-event");
    assert.deepEqual(s.speech, [], "nothing spoken");

    // the board underneath is furniture — but the way out is never taken away.
    assert.equal(s.asleep, s.tiles, "every tile is asleep");
    assert.deepEqual(s.doors, ["barDoor", "barTalk"], "both doors are still hers");

    // …and the sheet itself is a plain grown-up surface on HER screen.
    const sheet = await page.evaluate(() => {
      const el = document.getElementById("editSheet");
      const btns = [...el.querySelectorAll("button")];
      return {
        dwell: el.classList.contains("dwell") || el.querySelectorAll(".dwell").length > 0,
        dwellAttrs: [el, ...el.querySelectorAll("*")]
          .flatMap((n) => [...n.attributes].map((a) => a.name)).filter((n) => n.startsWith("data-dwell")),
        small: btns.map((b) => b.getBoundingClientRect()).filter((r) => r.height < 56).length,
        names: [...el.querySelectorAll(".edit-name")].map((n) => n.textContent),
        thumbs: [...el.querySelectorAll(".edit-row img")].map((i) => i.getAttribute("src")),
        cats: [...el.querySelectorAll(".edit-row")[0].querySelectorAll(".edit-chip")].map((c) => c.textContent),
        on: [...el.querySelectorAll(".edit-row")[0].querySelectorAll(".edit-chip.on")].map((c) => c.dataset.cat),
      };
    });
    assert.equal(sheet.dwell, false, "no gaze target in the sheet");
    assert.deepEqual(sheet.dwellAttrs, [], "and no dwell attribute either");
    assert.equal(sheet.small, 0, "every control is at least 56px tall");
    assert.deepEqual(sheet.names, ["Grey hoodie", "Pink leggings"],
      "the names come from the recipe's objects, never from the label");
    assert.deepEqual(sheet.thumbs, ["/wardrobe-items/item_h.jpg", "/wardrobe-items/item_b.jpg"],
      "the photo is the item's own, by id — the same path the tiles use");
    assert.equal(sheet.cats.length, 11, "every category the hub sent, and not one of the board's own");
    assert.deepEqual(sheet.on, ["top"], "the item's current category is the selected chip");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// Dad 9/27: on the Windows touchscreen the ring started, then stopped, on most
// holds. A firm press rolls; under `touch-action: manipulation` Chromium read
// the drift as a pan and sent pointercancel, which ends the hold. 30 px, because
// a 12 px drift stays under Chromium's ~15 px slop and proves nothing.
test("a finger that drifts 30px during the hold still opens the sheet — a firm press rolls, and rolling is not a pan (dwell.js 7/28)", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, outfitEvents, errors } = await open(browser);
    await hold(page, TILE, 2000, async ({ cdp, x, y }) => {
      for (const dx of [10, 20, 30]) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx, y }] });
        await page.waitForTimeout(60);
      }
    });
    await page.locator("#editSheet").waitFor({ timeout: 4000 });
    const s = await boardState(page);
    assert.equal(s.board, "today", "a drifting hold is still a hold: it never became a pick");
    assert.equal(s.rows, 2, "and it opened the outfit's sheet, both garments");
    assert.deepEqual(outfitEvents, [], "no /outfit-event");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a 1600ms finger on a garment tile opens the sheet with one row", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser);
    await page.evaluate(() => window.Board.show("cat_top"));
    await page.locator(GARMENT).waitFor({ timeout: 4000 });
    await hold(page, GARMENT, 2000);
    await page.locator("#editSheet").waitFor({ timeout: 4000 });
    const s = await boardState(page);
    assert.equal(s.rows, 1, "one garment, one row");
    assert.equal(s.board, "cat_top", "the hold did not navigate");
    assert.deepEqual(s.speech, [], "and the tile said nothing");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// ------------------------------------------- a press that is let go does NOTHING

test("released at 1000ms: no sheet, no pick, no word — and the tap-rescue stays quiet", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, outfitEvents, errors } = await open(browser);
    await hold(page, TILE, 1000);
    // dwell.js's rescue fires 150ms after a long-touch release; give it three
    // times that before believing it did not.
    await page.waitForTimeout(600);
    const s = await boardState(page);
    assert.equal(s.sheet, false, "the hold was abandoned: no sheet");
    assert.equal(s.board, "today", "and the abandoned hold is not a pick either");
    assert.deepEqual(outfitEvents, [], "no /outfit-event was posted");
    assert.deepEqual(s.speech, [], "nothing was spoken");
    assert.equal(s.awake, s.tiles, "the tile is hers again, .dwell and all");
    assert.equal(s.asleep, 0, "…with the attribute gone too");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a QUICK tap is still a tap: her board is not hold-only", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, outfitEvents, errors } = await open(browser);
    await hold(page, TILE, 60);
    await page.waitForFunction(() => window.Board.session.currentId === "confirm_0", null, { timeout: 4000 });
    await page.waitForTimeout(400);
    const s = await boardState(page);
    assert.equal(s.sheet, false, "a tap is not a hold");
    assert.equal(s.speech.filter((e) => e.call === "say").length, 1,
      "the pick is spoken exactly once — never twice (a replayed click and a native one)");
    assert.equal(s.speech.find((e) => e.call === "say").text, "Grey hoodie and pink leggings");
    assert.equal(outfitEvents.length, 1, "and exactly one /outfit-event");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// ------------------------------------------------------------- Done and Cancel

test("Done posts only what CHANGED, then reloads once the hub's rebuild lands", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, posts, recipeGets, errors } = await open(browser);
    await page.evaluate(() => window.Board.show("cat_top"));
    await page.locator(GARMENT).waitFor({ timeout: 4000 });
    await hold(page, GARMENT, 2000);
    await page.locator("#editSheet").waitFor({ timeout: 4000 });
    assert.equal(recipeGets.length, 1, "one recipe GET so far");

    await page.locator('#editSheet .edit-row[data-item-id="item_h"] .edit-chip[data-cat="jacket"]').click();
    await page.locator("#editDone").click();
    await page.waitForFunction(() => /Updating/.test(document.getElementById("editSheet").textContent),
                               null, { timeout: 4000 });
    assert.deepEqual(posts, [{ id: "item_h", category: "jacket" }],
      "one POST, and only the field a grown-up moved");

    // the rebuild flipped the recipe's ETag: the board she is looking at is the
    // old one, so the sheet reloads it.
    await page.waitForTimeout(2500);
    assert.ok(recipeGets.length >= 2, "the board reloaded: " + recipeGets.length + " recipe GETs");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("Done with nothing changed posts nothing at all", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, posts, errors } = await open(browser);
    await page.evaluate(() => window.Board.show("cat_top"));
    await page.locator(GARMENT).waitFor({ timeout: 4000 });
    await hold(page, GARMENT, 2000);
    await page.locator("#editSheet").waitFor({ timeout: 4000 });
    await page.locator("#editDone").click();
    await page.waitForFunction(() => !document.getElementById("editSheet"), null, { timeout: 4000 });
    assert.deepEqual(posts, [], "an unchanged row is not a request");
    const s = await boardState(page);
    assert.equal(s.awake, s.tiles, "and the board is hers again");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("Cancel posts nothing and hands the board straight back", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, posts, errors } = await open(browser);
    await page.evaluate(() => window.Board.show("cat_top"));
    await page.locator(GARMENT).waitFor({ timeout: 4000 });
    await hold(page, GARMENT, 2000);
    await page.locator("#editSheet").waitFor({ timeout: 4000 });
    await page.locator('#editSheet .edit-row[data-item-id="item_h"] .edit-chip[data-cat="jacket"]').click();
    await page.locator('#editSheet .edit-row[data-item-id="item_h"] .edit-hide').click();
    await page.locator("#editCancel").click();
    await page.waitForFunction(() => !document.getElementById("editSheet"), null, { timeout: 4000 });
    assert.deepEqual(posts, [], "Cancel is not a save");
    const s = await boardState(page);
    assert.equal(s.awake, s.tiles, "every tile woke up");
    assert.equal(s.asleep, 0, "…attribute and all");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a 400 keeps the sheet up, with the hub's own sentence and the values kept", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, posts, errors } = await open(browser,
      { item: { status: 400, body: { error: "That isn't a category Our Era Comms knows." } } });
    await page.evaluate(() => window.Board.show("cat_top"));
    await page.locator(GARMENT).waitFor({ timeout: 4000 });
    await hold(page, GARMENT, 2000);
    await page.locator("#editSheet").waitFor({ timeout: 4000 });
    await page.locator('#editSheet .edit-row[data-item-id="item_h"] .edit-chip[data-cat="jacket"]').click();
    await page.locator('#editSheet .edit-fancy').click();
    await page.locator("#editDone").click();
    await page.waitForFunction(() => /isn't a category/.test(document.getElementById("editSheet").textContent),
                               null, { timeout: 4000 });
    assert.equal(posts.length, 1, "it tried once and did not retry");
    const kept = await page.evaluate(() => ({
      cat: [...document.querySelectorAll("#editSheet .edit-chip.on")].map((c) => c.dataset.cat),
      fancy: document.querySelector("#editSheet .edit-fancy").classList.contains("on"),
    }));
    assert.deepEqual(kept.cat, ["jacket"], "the grown-up's choice is still on screen");
    assert.equal(kept.fancy, true, "…both of them");
    const s = await boardState(page);
    assert.equal(s.sheet, true, "the sheet stays open to try again");
    assert.equal(s.asleep, s.tiles, "and the board stays asleep under it");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// --------------------------------------------------------- the standing footers

test("the sheet sits ABOVE the wardrobe footer instead of painting on it", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser);
    const foot = await page.evaluate(() => {
      const w = document.getElementById("wardrobeNote");
      w.textContent = "👕 New clothing photos found — adding photo 1 of 4.";
      w.classList.add("show");
      const r = w.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    });
    assert.ok(foot.height > 0, "the wardrobe footer is really showing");

    await hold(page, TILE, 2000);
    await page.locator("#editSheet").waitFor({ timeout: 4000 });
    const m = await page.evaluate(() => {
      const s = document.getElementById("editSheet"), w = document.getElementById("wardrobeNote");
      const sr = s.getBoundingClientRect(), wr = w.getBoundingClientRect();
      return { sheetBottom: sr.bottom, inline: s.style.bottom, footTop: wr.top, footBottom: wr.bottom };
    });
    assert.ok(m.sheetBottom <= m.footTop + 0.5,
      "the sheet clears the footer: " + m.sheetBottom + " > " + m.footTop);
    assert.ok(parseInt(m.inline, 10) >= Math.round(foot.height) + 6,
      "and it measured rather than guessed: bottom " + m.inline + " for a " +
      Math.round(foot.height) + "px footer");
    assert.equal(m.footBottom, foot.bottom, "the standing footer did not move for it");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});
