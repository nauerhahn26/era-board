// board-music.test.mjs — Songs Board behavior (spec 8/24) against the test
// server's synthetic music fixture (era-family/test-data/music: 8 ~1s WAVs).
// Proves, as she would experience it: layout (3x4, Stop top-left, 7 cover-art
// song tiles, center rests, More/exit anchors, page-2 back), tap plays real
// audio + .playing marker + play telemetry, a second pick barges the first
// out, Stop silences, page nav does NOT stop the music, song end -> silence
// (no queue), and the IndexedDB cache keeps songs playing with the network
// DEAD (context.setOffline after prefetch).
// Runs under `node --test` or `node tests/board-music.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/?recipe=songs";

// Hermetic page: Speech spy armed, /music-event captured (never the pool),
// /music/* passes through to the real server (the thing under test).
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
  await ctx.addInitScript(() => {
    window.__testHooks = true;   // arm the Speech spy in board.js
    window.__musicCached = null; // prefetch-complete beacon
    window.addEventListener("music:prefetched", (e) => { window.__musicCached = e.detail; });
    // hermetic IDB: each context starts cold (playwright contexts already do)
  });
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

test("songs board: layout, playback, barge-in, stop, nav, song-end, offline", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, musicEvents } = await makePage(browser);

    // ---- layout: the shape she already knows ----
    assert.equal(await page.locator(".tile.type-song").count(), 7, "7 song tiles on page 1");
    assert.equal(await page.locator(".cell.rest").count(), 2, "two center rest cells");
    assert.equal(await page.locator(".tile.type-stop").count(), 1, "Stop tile present");
    assert.equal(await page.locator(".tile.type-more").count(), 1, "More door present");
    assert.equal(await page.locator(".tile.type-exit").count(), 1, "exit anchor present");
    // song tiles are cover-art photo tiles; Stop is a text tile at the 74 floor
    assert.ok(await page.locator(".tile.type-song.photo").count() === 7, "covers render photo-style");
    const stopFont = await page.locator(".tile.type-stop .tile-label").evaluate((el) => Number(el.dataset.fontPx));
    assert.ok(stopFont >= 74, `Stop label >= 74px floor (got ${stopFont})`);
    const gap = await page.locator(".board-area").evaluate((el) => getComputedStyle(el).gap);
    assert.equal(gap, "28px", "contract grid gap");

    // ---- tap a song: it PLAYS (real audio), marker on, telemetry sent ----
    await page.evaluate(() => { window.__speechLog.length = 0; });
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, "test-song-1");
    assert.ok(await page.locator(".tile.type-song.playing").count() === 1, ".playing marker on");
    const log1 = await page.evaluate(() => window.__speechLog.slice());
    assert.ok(log1.some((e) => e.call === "stop"), "barge-in: Speech.stop fired");
    assert.ok(!log1.some((e) => e.call === "say"), "a song pick does not speak over the song");
    assert.deepEqual(musicEvents.at(-1), { songId: "test-song-1", action: "play" });

    // ---- second pick barges the first out ----
    await page.locator(".tile.type-song").nth(1).click();
    await waitPlaying(page, "test-song-2");
    const marked = await page.locator(".tile.type-song.playing .tile-label").textContent();
    assert.equal(marked, "Test Song 2", "marker moved to the new song");

    // ---- Stop tile: silence, marker off, stop telemetry ----
    await page.locator(".tile.type-stop").click();
    await page.waitForFunction(() => window.Music.playingId() === null);
    assert.equal((await audioState(page)).paused, true, "audio paused");
    assert.equal(await page.locator(".tile.playing").count(), 0, "marker cleared");
    assert.deepEqual(musicEvents.at(-1), { songId: "test-song-2", action: "stop" });

    // ---- page nav does NOT stop the music (she browses while listening) ----
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, "test-song-1");
    await page.locator(".tile.type-more").click();
    await page.waitForSelector(".tile.type-back");
    assert.equal((await audioState(page)).paused, false, "still playing on page 2");
    assert.equal(await page.locator(".tile.type-song").count(), 1, "rank 8 on page 2");
    await page.locator(".tile.type-back").click();
    await page.waitForSelector(".tile.type-stop");
    assert.ok(await page.locator(".tile.type-song.playing").count() === 1,
      "marker re-applied after nav while playing");

    // ---- song end -> silence (no queue, no autoplay-next) ----
    await page.waitForFunction(() => window.Music.playingId() === null, null, { timeout: 15000 });
    assert.equal((await audioState(page)).paused, true, "silent after the ~1s fixture song ends");
    assert.deepEqual(musicEvents.at(-1), { songId: "test-song-1", action: "end" });

    // ---- offline resiliency: cached songs play with the network DEAD ----
    await page.waitForFunction(() => window.__musicCached !== null, null, { timeout: 20000 });
    const cached = await page.evaluate(() => window.__musicCached);
    assert.equal(cached.cached, cached.total, "prefetch cached every song");
    await ctx.setOffline(true);
    await page.locator(".tile.type-song").nth(2).click();
    await waitPlaying(page, "test-song-3");
    assert.equal((await audioState(page)).paused, false, "IDB-cached song plays offline");
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
