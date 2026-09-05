// board-partner-strip.test.mjs — the grown-up's strip in the board header (T4.4).
//
// Dad's 9/4 amendment to the board design rules: grown-up controls MAY live in
// the header, but only as a touch/click strip — the same class as the
// #wardrobeNote footer. So this suite pins the amendment's whole price:
//   * the strip exists on ?recipe=songs and ?recipe=movies and NOWHERE else
//     (the outfit board's bar still carries the door and nothing else, which is
//     what board-input / board-pixel / board-wardrobe-note keep asserting);
//   * the door stays the message bar's ONLY dwell target, and nothing in the
//     strip carries .dwell or a data-dwell-* attribute — a gaze parked on it
//     for twice the longest hold must activate nothing;
//   * the bar is still the <=9% slab (dad 9/2 "the header is still too big");
//   * and the sheet the strip opens SHIELDS the board — a gaze parked on a tile
//     beneath the backdrop fires nothing, because a backdrop alone does not
//     stop dwell.js (review 9/5).
// Then the feature itself: "+ Add" opens a pointer-only sheet that posts to the
// hub's /music/add ({url} for a pasted link, {query} for a typed name) and puts
// the hub's own answer — the 202, or "the pack is missing" — on screen in the
// words a parent can act on.
//
// Hermetic: every hub route the board touches is stubbed, so the test never
// downloads a song, never runs yt-dlp and never reaches YouTube; the page
// itself is served by the gate's hub (port re-pointed by era-gate.sh), so this
// suite holds no port of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/";
const QUIET_CLOTHING = { building: false, ingesting: null, photos: 3, cataloged: 3, aiConfigured: true };
const QUIET_CONTENT = { mode: "local", local: true, skipped: null, building: false, job: null,
                        queued: [], jobs: [], lastScan: null };
const IDLE_ADD = { pack: { id: "media-tools", installed: true }, folder: true, running: null, last: null };

// One board page with every hub route stubbed. `dial` is what the test turns:
//   dial.add     -> the answer /music/add gives (status + body)
//   dial.addStat -> what /music/add/status reports while the sheet waits
// `posts` collects what the sheet actually sent.
async function open(browser, recipe, dial) {
  const d = Object.assign({ add: { status: 202, body: { started: true } }, addStat: () => IDLE_ADD }, dial || {});
  const posts = [];
  const installs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true });
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/music-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/clothing/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CLOTHING) }));
  await ctx.route("**/content/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CONTENT) }));
  // the status door first: "**/music/add" must not swallow "/music/add/status"
  await ctx.route("**/music/add/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(d.addStat()) }));
  await ctx.route("**/music/add", (r) => {
    posts.push({ body: r.request().postDataJSON(), type: r.request().headers()["content-type"] || "" });
    r.fulfill({ status: d.add.status, contentType: "application/json", body: JSON.stringify(d.add.body) });
  });
  // the pack door of last resort (hub review 9/5): media-tools belongs to no
  // app, so this is the only way the sheet's offer can ever be real.
  await ctx.route("**/packs/install", (r) => {
    installs.push({ body: r.request().postDataJSON(), type: r.request().headers()["content-type"] || "" });
    r.fulfill({ status: 202, contentType: "application/json", body: '{"installing":true}' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch {}
    window.__activateCount = 0;
    document.addEventListener("dwell:activate", () => { window.__activateCount++; }, true);
    window.__boardTest = { statusMs: 60 * 60 * 1000, busyMs: 60 * 60 * 1000,
                           pollMs: 60 * 60 * 1000, idleMs: 60 * 60 * 1000, retryMs: 300,
                           addPollMs: 120 };
  });
  await page.goto(BASE + (recipe ? "?recipe=" + recipe : ""), { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  return { ctx, page, posts, installs, errors, dial: d };
}

// what the bar is made of, from the page's own point of view
const barShape = (page) => page.evaluate(() => {
  const bar = document.querySelector(".msgbar");
  const strip = document.getElementById("partnerStrip");
  return {
    kids: [...bar.children].map((el) => el.id || String(el.className)),
    hPct: +((bar.getBoundingClientRect().height / innerHeight) * 100).toFixed(1),
    barDwell: [...bar.querySelectorAll(".dwell")].map((el) => el.id),
    strip: !!strip,
    stripInBar: !!strip && strip.parentElement === bar,
    stripDwell: !!strip && (strip.classList.contains("dwell") || strip.querySelectorAll(".dwell").length > 0),
    stripDwellAttrs: !strip ? [] : [strip, ...strip.querySelectorAll("*")]
      .flatMap((el) => [...el.attributes].map((a) => a.name))
      .filter((n) => n.startsWith("data-dwell")),
    labels: !strip ? [] : [...strip.querySelectorAll("button")].map((b) => b.textContent.trim()),
  };
});

test("songs board: the strip rides in the bar, and the door keeps the bar's only dwell", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs");
    const bar = await barShape(page);
    assert.deepEqual(bar.kids, ["barDoor", "partnerStrip"], "the bar carries the door and the one partner strip");
    assert.ok(bar.stripInBar, "the strip is a child of the message bar");
    assert.deepEqual(bar.barDwell, ["barDoor"], "the door is the bar's only dwell target");
    assert.equal(bar.stripDwell, false, "nothing in the strip is a gaze target");
    assert.deepEqual(bar.stripDwellAttrs, [], "nothing in the strip carries a dwell attribute");
    assert.deepEqual(bar.labels, ["+ Add", "⇅ Arrange"], "the strip's two grown-up doors");
    assert.ok(bar.hPct <= 9.1, `bar is still a slim strip (was ${bar.hPct}% of the viewport)`);
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a gaze parked on the strip activates nothing", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await open(browser, "songs");
    // ERAgaze drives the real cursor, so a parked gaze IS a parked pointer.
    const box = await page.locator("#stripAdd").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(2600);   // > the longest hold on the board (2400ms door)
    assert.equal(await page.evaluate(() => window.__activateCount), 0, "no dwell:activate ever fires on the strip");
    assert.equal(await page.locator(".dwell-active").count(), 0, "no dwell fill starts under the pointer");
    assert.equal(await page.locator("#partnerSheet").count(), 0, "and the sheet never opened itself");
    await ctx.close();
  } finally { await browser.close(); }
});

test("movies board gets the strip; the outfit board's bar still carries the door alone", async () => {
  const browser = await chromium.launch();
  try {
    const movies = await open(browser, "movies");
    const mBar = await barShape(movies.page);
    assert.deepEqual(mBar.kids, ["barDoor", "partnerStrip"], "movies board: door + strip");
    assert.deepEqual(mBar.barDwell, ["barDoor"], "movies board: the door is still the bar's only dwell target");
    await movies.ctx.close();

    const today = await open(browser, "");
    const tBar = await barShape(today.page);
    assert.deepEqual(tBar.kids, ["barDoor"], "her outfit board is untouched: the door and nothing else");
    assert.equal(tBar.strip, false, "no strip on the board she uses alone");
    await today.ctx.close();
  } finally { await browser.close(); }
});

test("+ Add sends a pasted link as a link and says the song is coming", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, posts, errors } = await open(browser, "songs");
    await page.locator("#stripAdd").click();
    const sheet = page.locator("#partnerSheet");
    await sheet.waitFor();
    assert.equal(await page.locator("#partnerSheet .dwell").count(), 0, "the sheet is pointer-only too");
    await page.fill("#sheetInput", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await page.locator("#sheetGo").click();
    await page.waitForFunction(() => /New ERA is fetching/.test(document.getElementById("sheetSay").textContent), null, { timeout: 4000 });
    assert.equal(posts.length, 1, "one POST /music/add");
    assert.deepEqual(posts[0].body, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, "a link goes as {url}");
    assert.ok(posts[0].type.startsWith("application/json"), "JSON, so the hub's own-door check lets it through");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a typed name goes as a name, and the landed song is reported", async () => {
  const browser = await chromium.launch();
  try {
    let stat = { ...IDLE_ADD, running: { title: "twinkle twinkle", phase: "downloading it" } };
    const { ctx, page, posts } = await open(browser, "songs", { addStat: () => stat });
    await page.locator("#stripAdd").click();
    await page.fill("#sheetInput", "  twinkle twinkle  ");
    await page.locator("#sheetGo").click();
    await page.waitForFunction(() => /downloading it/.test(document.getElementById("sheetSay").textContent), null, { timeout: 4000 });
    assert.deepEqual(posts[0].body, { query: "twinkle twinkle" }, "a name goes as {query}, trimmed");
    stat = { ...IDLE_ADD, running: null, last: { ok: true, id: "twinkle-twinkle", title: "Twinkle Twinkle", rank: 9, error: "", when: "now" } };
    await page.waitForFunction(() => /Twinkle Twinkle is on the board/.test(document.getElementById("sheetSay").textContent), null, { timeout: 4000 });
    await ctx.close();
  } finally { await browser.close(); }
});

// The amendment proved the STRIP is gaze-unreachable and then opened a
// full-screen overlay that was gaze-TRANSPARENT: era-core/dwell.js's
// targetAt() walks the whole elementsFromPoint stack for the first
// .dwell:not([data-dwell-disabled]), so a backdrop with no .dwell is simply
// stepped over. While a grown-up typed into the sheet, a parked gaze could
// still open a song behind it (review 9/5). Arrange mode already knew the fix.
test("the sheet shields the board: a gaze parked on a tile beneath it fires nothing", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, "songs");
    const tile = page.locator(".board-area .tile.dwell").first();
    await tile.waitFor({ timeout: 8000 });
    const box = await tile.boundingBox();
    const before = await page.evaluate(() => window.Board.session.currentId);

    await page.locator("#stripAdd").click();
    await page.locator("#partnerSheet").waitFor();
    const frozen = await page.evaluate(() => ({
      dwellTiles: document.querySelectorAll(".board-area .tile.dwell").length,
      disabled: document.querySelectorAll(".board-area .tile[data-dwell-disabled]").length,
      tiles: document.querySelectorAll(".board-area .tile").length,
      doorDwell: !!document.querySelector(".bardoor.dwell"),
    }));
    assert.equal(frozen.dwellTiles, 0, "with the sheet up, not one tile is a gaze target");
    assert.equal(frozen.disabled, frozen.tiles, "every tile says so in the attribute dwell.js reads");
    assert.equal(frozen.doorDwell, true, "the way out of the board is never taken away");

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(2600);   // > the longest hold on the board (2400ms door)
    assert.equal(await page.evaluate(() => window.__activateCount), 0,
                 "a gaze parked under the sheet never fires the tile beneath it");
    assert.equal(await page.locator(".dwell-active").count(), 0, "no dwell fill starts under the sheet");
    assert.equal(await page.evaluate(() => window.Board.session.currentId), before,
                 "and the board is exactly where the grown-up left it");

    await page.locator("#sheetClose").click();
    await page.waitForFunction(() => !document.getElementById("partnerSheet"), null, { timeout: 4000 });
    const back = await page.evaluate(() => ({
      dwellTiles: document.querySelectorAll(".board-area .tile.dwell").length,
      disabled: document.querySelectorAll(".board-area .tile[data-dwell-disabled]").length,
    }));
    assert.ok(back.dwellTiles > 0, "closing the sheet gives her the board back");
    assert.equal(back.disabled, 0, "with nothing left switched off");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("no pack, no download attempt — the hub's plain words land in the sheet", async () => {
  const browser = await chromium.launch();
  try {
    const missing = { error: "pack-missing", pack: "media-tools",
                      message: "Adding songs from the web needs a one-time download of about 18 MB. Install it and try again." };
    const { ctx, page } = await open(browser, "songs", { add: { status: 409, body: missing } });
    await page.locator("#stripAdd").click();
    await page.fill("#sheetInput", "https://example.com/song");
    await page.locator("#sheetGo").click();
    await page.waitForFunction((want) => document.getElementById("sheetSay").textContent.includes(want),
                              missing.message, { timeout: 4000 });
    // and the sheet stays open so the parent can act on it
    assert.equal(await page.locator("#partnerSheet").isVisible(), true);
    await page.locator("#sheetClose").click();
    await page.waitForFunction(() => !document.getElementById("partnerSheet"), null, { timeout: 4000 });
    await ctx.close();
  } finally { await browser.close(); }
});

// "Install it and try again" has to lead somewhere. media-tools is unticked in
// the installer by default and belongs to no app, so until POST /packs/install
// existed (hub review 9/5) the sheet was telling a parent to press a button
// that was nowhere on the machine.
test("no pack: the sheet offers the install, and the offer really installs it", async () => {
  const browser = await chromium.launch();
  try {
    const missing = { error: "pack-missing", pack: "media-tools",
                      message: "Adding songs from the web needs a one-time download of about 18 MB. Install it and try again." };
    let stat = { ...IDLE_ADD, pack: { id: "media-tools", installed: false } };
    const { ctx, page, installs, errors } =
      await open(browser, "songs", { add: { status: 409, body: missing }, addStat: () => stat });
    await page.locator("#stripAdd").click();
    await page.fill("#sheetInput", "https://example.com/song");
    await page.locator("#sheetGo").click();

    const install = page.locator("#sheetInstall");
    await install.waitFor({ timeout: 4000 });
    assert.equal(await page.locator("#partnerSheet .dwell").count(), 0, "the offer is pointer-only too");
    await install.click();
    await page.waitForFunction(() => /New ERA is getting/i.test(document.getElementById("sheetSay").textContent),
                               null, { timeout: 4000 });
    assert.equal(installs.length, 1, "one POST /packs/install");
    assert.deepEqual(installs[0].body, { pack: "media-tools" }, "and it names the pack the hub asked for");
    assert.ok(installs[0].type.startsWith("application/json"), "JSON, so the hub's own-door check lets it through");

    // the hub finishes the download; the sheet is watching the status door it
    // already polls, and hands the parent back the "Add it" button.
    stat = { ...IDLE_ADD, pack: { id: "media-tools", installed: true } };
    await page.waitForFunction(() => !document.getElementById("sheetInstall"), null, { timeout: 6000 });
    await page.waitForFunction(() => !document.getElementById("sheetGo").disabled, null, { timeout: 4000 });
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});
