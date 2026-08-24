// board-music.test.mjs — Songs Board v2 behavior (dad's 8/24 feedback round)
// against the test server's synthetic fixture (era-family/test-data/music:
// 8 ~3s WAVs). The model under test: the GRID has song doors only (no Stop,
// no All done); a song pick opens the song's own page AND starts the default
// clip; the hero replays it; Full song un-caps the running clip WITHOUT a
// restart; leaving the page stops the music; clip end = silence; the IDB
// cache keeps all of it working with the network dead. Clip length is
// overridden to 1.5s via window.__musicTest (real recipes say 40s).
// Runs under `node --test` or `node tests/board-music.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/?recipe=songs";
const CLIP_MS = 1500;   // test override; fixture songs run ~3s

async function makePage(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    hasTouch: true,
  });
  const musicEvents = [];
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/music-event", (r) => {
    musicEvents.push(r.request().postDataJSON());
    r.fulfill({ status: 204, body: "" });
  });
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.addInitScript((clip) => {
    window.__testHooks = true;   // arm the Speech spy in board.js
    window.__musicTest = { clipMs: clip };
    window.__musicCached = null;
    window.addEventListener("music:prefetched", (e) => { window.__musicCached = e.detail; });
  }, CLIP_MS);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && window.Music, null, { timeout: 8000 });
  return { ctx, page, musicEvents };
}

const audioState = (page) => page.evaluate(() => ({
  paused: window.Music._audio.paused,
  t: window.Music._audio.currentTime,
  playing: window.Music.playingId(),
}));
const waitPlaying = (page, id) => page.waitForFunction(
  (want) => window.Music.playingId() === want &&
            !window.Music._audio.paused && window.Music._audio.currentTime > 0,
  id, { timeout: 8000 });
const waitSilent = (page, ms = 8000) => page.waitForFunction(
  () => window.Music.playingId() === null, null, { timeout: ms });
const onBoard = (page, id) => page.evaluate(() => window.Board.session.currentId);

test("songs board v2: grid, song page flow, clip, full, back-stops, offline", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, musicEvents } = await makePage(browser);

    // ---- grid page 1 (v3): 9 song doors incl. corners, More, center rests ----
    assert.equal(await page.locator(".tile.type-song").count(), 9, "9 song tiles");
    assert.equal(await page.locator(".tile.type-stop").count(), 0, "no Stop on the grid");
    assert.equal(await page.locator(".tile.type-exit").count(), 0, "no All done tile");
    assert.equal(await page.locator(".cell.rest").count(), 2, "center rests only");
    assert.equal(await page.locator(".tile.type-more").count(), 1, "More door present");

    // ---- pick a song: song page opens AND the clip starts ----
    await page.evaluate(() => { window.__speechLog.length = 0; });
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, "test-song-1");
    assert.equal(await onBoard(page), "song-test-song-1", "landed on the song page");
    // song page chrome: big hero left, arrow back / Stop / Full song, rest col
    const hero = page.locator(".tile.type-song");
    assert.equal(await hero.count(), 1, "one hero tile");
    const hb = await hero.boundingBox();
    assert.ok(hb.width > 1920 * 0.4, `hero spans the left half (w=${Math.round(hb.width)})`);
    assert.ok(hb.height > 500, `hero is tall (h=${Math.round(hb.height)})`);
    const backTile = page.locator(".tile.type-back");
    assert.equal(await backTile.evaluate((el) => el.querySelector(".tile-glyph").textContent), "←",
      "back is the big left arrow");
    assert.equal(await backTile.locator(".tile-label").textContent(), "Back",
      "arrow AND the word (dad r3)");
    assert.equal(await page.locator(".tile.type-stop").count(), 1, "Stop lives on the song page");
    assert.ok((await page.locator(".tile.type-stop img.tile-img").getAttribute("src")).includes("/symbol/8289"),
      "Stop wears the stop-sign pictogram");
    assert.equal(await page.locator(".tile.type-full").count(), 1, "Full song present");
    assert.ok((await page.locator(".tile.type-full img.tile-img").getAttribute("src")).includes("/symbol/music"),
      "Full song wears the music pictogram");
    assert.equal(await page.locator(".cell.rest").count(), 3, "black rest column for her eyes");
    const log1 = await page.evaluate(() => window.__speechLog.slice());
    assert.ok(log1.some((e) => e.call === "stop"), "barge-in: Speech.stop fired");
    assert.ok(!log1.some((e) => e.call === "say"), "song pick is silent (music is the response)");
    assert.deepEqual(musicEvents.at(-1), { songId: "test-song-1", action: "play" });

    // ---- the clip caps playback: ~1.5s then silence, still on the page ----
    await waitSilent(page);
    const s1 = await audioState(page);
    assert.equal(s1.paused, true, "clip over -> paused");
    assert.ok(s1.t >= CLIP_MS / 1000 - 0.5 && s1.t < 2.9, `stopped near the clip cap (t=${s1.t.toFixed(2)})`);
    assert.equal(await onBoard(page), "song-test-song-1", "stays on the song page");
    assert.deepEqual(musicEvents.at(-1), { songId: "test-song-1", action: "end" });

    // ---- hero replays the clip ----
    await page.locator(".tile.type-song").click();
    await waitPlaying(page, "test-song-1");
    assert.ok(await page.locator(".tile.type-song.playing").count() === 1, "hero wears the ring");

    // ---- Full song mid-clip: un-caps IN PLACE (no restart), plays to the end,
    //      and the UI acknowledges the mode (dad r3) ----
    await page.waitForFunction(() => window.Music._audio.currentTime > 0.4);
    assert.equal(await page.locator(".tile.type-song .full-badge").isVisible(), false,
      "no badge during a plain clip");
    const tBefore = (await audioState(page)).t;
    await page.locator(".tile.type-full").click();
    assert.deepEqual(musicEvents.at(-1), { songId: "test-song-1", action: "full" });
    await page.waitForSelector(".tile.type-song.full-on .full-badge", { state: "visible" });
    assert.equal(await page.locator(".tile.type-song .full-badge").textContent(), "Full song ✓",
      "hero acknowledges full mode under the image");
    assert.ok(await page.locator(".tile.type-full.active").count() === 1,
      "the Full song tile goes active too");
    await page.waitForTimeout(400);
    const s2 = await audioState(page);
    assert.equal(s2.paused, false, "still playing after Full song");
    assert.ok(s2.t > tBefore, `no restart (t ${tBefore.toFixed(2)} -> ${s2.t.toFixed(2)})`);
    await waitSilent(page, 6000);   // natural end of the 3s fixture song
    const s3 = await audioState(page);
    assert.ok(s3.t > 2.5 || s3.paused, "played past the clip cap to the real end");
    assert.deepEqual(musicEvents.at(-1), { songId: "test-song-1", action: "end" });
    assert.equal(await page.locator(".tile.type-song.full-on").count(), 0,
      "badge clears when the song ends");

    // ---- Stop on the page: silence, stay on the page ----
    await page.locator(".tile.type-song").click();
    await waitPlaying(page, "test-song-1");
    await page.locator(".tile.type-stop").click();
    await waitSilent(page);
    assert.equal(await onBoard(page), "song-test-song-1", "Stop does not navigate");
    assert.deepEqual(musicEvents.at(-1), { songId: "test-song-1", action: "stop" });

    // ---- back arrow: leaves the page AND stops the music ----
    await page.locator(".tile.type-song").click();
    await waitPlaying(page, "test-song-1");
    await page.locator(".tile.type-back").click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs");
    await waitSilent(page);
    assert.equal((await audioState(page)).paused, true,
      "leaving the song page stops playback (why the grid needs no Stop)");
    assert.deepEqual(musicEvents.at(-1), { songId: "test-song-1", action: "stop" });

    // ---- grid page 2: 3 remaining songs, arrow-back door ----
    await page.locator(".tile.type-more").click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-2");
    assert.equal(await page.locator(".tile.type-song").count(), 3, "ranks 10-12 on page 2");
    assert.equal(await page.locator(".tile.type-back .tile-glyph").textContent(), "←");
    await page.locator(".tile.type-back").click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs");

    // ---- offline: cached songs still open their page and play the clip ----
    await page.waitForFunction(() => window.__musicCached !== null, null, { timeout: 30000 });
    const cached = await page.evaluate(() => window.__musicCached);
    assert.equal(cached.cached, cached.total, "prefetch cached every song");
    await ctx.setOffline(true);
    await page.locator(".tile.type-song").nth(2).click();
    await waitPlaying(page, "test-song-3");
    assert.equal(await onBoard(page), "song-test-song-3");
    await ctx.setOffline(false);
  } finally { await browser.close(); }
});

test("outfit board is untouched: no Music player, no song tiles", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
    await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
    const page = await ctx.newPage();
    await page.goto("http://localhost:8377/board/", { waitUntil: "load" });
    await page.waitForFunction(() => window.Board, null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => !!window.Music), false, "no player on the outfit board");
    assert.equal(await page.locator(".tile.type-song").count(), 0);
  } finally { await browser.close(); }
});
