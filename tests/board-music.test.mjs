// board-music.test.mjs — Songs Board v2 behavior (dad's 8/24 feedback round)
// against the test server's synthetic fixture (era-family/test-data/music:
// 8 ~3s WAVs). The model under test: the GRID has song doors only (no Stop,
// no All done); a song pick opens the song's own page AND starts the default
// clip; the hero replays it; Full song un-caps the running clip WITHOUT a
// restart; leaving the page stops the music; clip end = silence; the IDB
// cache keeps all of it working with the network dead. Clip length is
// overridden to 1.5s via window.__musicTest (real recipes say 40s).
// Since 2026-10-31 (spec music-sections-and-usage-order) every grid page has a
// rail of sections — Back, Favorites, New, Top hits, Disney, All — beside the
// 3x4 grid; the order comes from the hub and never moves while she is on a
// page; a song page's Back returns to the section page she came from. Order
// within a section depends on the shared hub's pick history and each fixture
// file's added time, so these tests read song ids off the page, never assume.
// Runs under `node --test` or `node tests/board-music.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/?recipe=songs";
const CLIP_MS = 1500;   // test override; fixture songs run ~3s

async function makePage(browser, pictures = false) {
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
  if (pictures) {
    await ctx.route("**/recipes/songs.json", async route => {
      const response = await route.fetch();
      const recipe = await response.json();
      const first = recipe.boards.find(b => b.id === "songs-all").buttons.find(b => b.row === 1 && b.col === 1).song_id;
      const hero = recipe.boards.find(b => b.id === "song-" + first).buttons.find(b => b.type === "song");
      hero.pictures = Array.from({ length: 10 }, (_, i) => "music/" + first + "-frame-0123456789abcdef-" + String(i).padStart(2, "0") + ".jpg");
      await route.fulfill({ response, json: recipe });
    });
    await ctx.route("**/music/*-frame-*.jpg", route => route.fulfill({ status: 200, contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6o4sAAAAASUVORK5CYII=", "base64") }));
  }
  await ctx.addInitScript((clip) => {
    window.__testHooks = true;   // arm the Speech spy in board.js
    window.__musicTest = { clipMs: clip };
    window.__musicCached = null;
    window.addEventListener("music:prefetched", (e) => { window.__musicCached = e.detail; });
  }, CLIP_MS);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && window.Music, null, { timeout: 8000 });
  // All holds every song whatever has been played: start there
  await page.locator('.rail .tile[aria-label="All"]').click();
  await page.waitForFunction(() => window.Board.session.currentId === "songs-all");
  return { ctx, page, musicEvents };
}
// the song ids on the grid, in the spec's cell order
const CELLS = [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]];
const gridSongs = (page) => page.evaluate((cells) => cells.map(([r, c]) => {
  const el = document.querySelector(`.board-area [data-cell="${r},${c}"].tile.type-song`);
  return el ? el.dataset.songId : null;
}).filter(Boolean), CELLS);

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

    // ---- the rail: six tiles, top to bottom, the current section lit ----
    const rail = await page.evaluate(() => [...document.querySelectorAll(".rail > .tile")].map((t) => ({
      label: t.getAttribute("aria-label"), lit: t.classList.contains("is-current"),
      dwell: t.classList.contains("dwell"), disabled: t.hasAttribute("data-dwell-disabled"),
      ms: t.dataset.dwellMs })));
    assert.deepEqual(rail.map((t) => t.label), ["Back", "Favorites", "New", "Top hits", "Disney", "All"]);
    assert.deepEqual(rail.filter((t) => t.lit).map((t) => t.label), ["All"], "the current section is lit");
    assert.deepEqual(rail.filter((t) => t.dwell).map((t) => t.label), ["Favorites", "New", "Top hits", "Disney", "All"],
      "every section is a dwell target");
    assert.deepEqual(rail.filter((t) => t.disabled).map((t) => t.label), ["Back"], "Back is dwell-disabled on page 1");
    const dwell = await page.evaluate(() => document.querySelector(".board-area .tile.type-song").dataset.dwellMs);
    assert.ok(rail.every((t) => t.ms === dwell), "rail tiles hold her Settings dwell, like the grid");
    // a finger on the dimmed Back does nothing either
    await page.locator('.rail .tile[aria-label="Back"]').click({ force: true });
    assert.equal(await onBoard(page), "songs-all", "Back on page 1 stays put");

    // ---- the grid: 9 song doors in the spec's cells, More [3,1], centre black ----
    assert.equal(await page.locator(".tile.type-song").count(), 9, "9 song tiles");
    assert.equal(await page.locator(".tile.type-stop").count(), 0, "no Stop on the grid");
    assert.equal(await page.locator(".tile.type-exit").count(), 0, "no All done tile");
    assert.equal(await page.locator(".cell.rest").count(), 2, "center rests only");
    const centre = await page.evaluate(() => [...document.querySelectorAll(".board-area .cell.rest")]
      .map((el) => el.dataset.cell));
    assert.deepEqual(centre.sort(), ["2,2", "2,3"], "[2,2] and [2,3] are the black cells");
    const page1 = await gridSongs(page);
    assert.equal(page1.length, 9);
    const moreTile = page.locator('.tile.type-control:has-text("More")');
    assert.equal(await moreTile.count(), 1, "More door present (outfit-style control tile)");
    assert.ok((await moreTile.locator("img.tile-img").getAttribute("src")).includes("/symbol/more"),
      "More wears the outfit board's more image");
    // ---- pick a song: song page opens AND the clip starts ----
    await page.evaluate(() => { window.__speechLog.length = 0; });
    const first = page1[0];
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, first);
    assert.equal(await onBoard(page), "song-" + first, "landed on the song page");
    // song page chrome: big hero left, arrow back / Stop / Full song, rest col
    const hero = page.locator(".tile.type-song");
    assert.equal(await hero.count(), 1, "one hero tile");
    const hb = await hero.boundingBox();
    assert.ok(hb.width > 1920 * 0.7, `hero spans three quarters (w=${Math.round(hb.width)})`);
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
    assert.equal(await page.locator(".cell.rest").count(), 0, "song page has no black rest cells");
    assert.ok((await backTile.boundingBox()).x >= hb.x + hb.width, "controls occupy the far-right column");
    const log1 = await page.evaluate(() => window.__speechLog.slice());
    assert.ok(log1.some((e) => e.call === "stop"), "barge-in: Speech.stop fired");
    assert.ok(!log1.some((e) => e.call === "say"), "song pick is silent (music is the response)");
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "play" });

    // ---- the clip caps playback: ~1.5s then silence, still on the page ----
    await waitSilent(page);
    const s1 = await audioState(page);
    assert.equal(s1.paused, true, "clip over -> paused");
    assert.ok(s1.t >= CLIP_MS / 1000 - 0.5 && s1.t < 2.9, `stopped near the clip cap (t=${s1.t.toFixed(2)})`);
    assert.equal(await onBoard(page), "song-" + first, "stays on the song page");
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "clip" },
      "the clip running out is told apart from the song ending");

    // ---- Full song AFTER clip expiry: continues from the mark (dad r6) ----
    const tClip = (await audioState(page)).t;
    await page.locator(".tile.type-full").click();
    await waitPlaying(page, first);
    const sF = await audioState(page);
    assert.ok(sF.t >= tClip - 0.05, `continued from the clip mark (${tClip.toFixed(2)} -> ${sF.t.toFixed(2)})`);
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "full" });
    await waitSilent(page, 6000);   // plays the REST to the natural end
    assert.ok((await audioState(page)).t > 2.5, "played the rest of the song");
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "done" });

    // ---- hero from silence (after a natural end): starts FRESH (dad r5) ----
    await page.locator(".tile.type-song").click();
    await waitPlaying(page, first);
    assert.ok((await audioState(page)).t < 1.0, "post-end hero starts from the beginning");
    assert.ok(await page.locator(".tile.type-song.playing").count() === 1, "hero wears the ring");

    // ---- Full song mid-clip: un-caps IN PLACE (no restart), plays to the end,
    //      and the UI acknowledges the mode (dad r3) ----
    await page.waitForFunction(() => window.Music._audio.currentTime > 0.4);
    assert.equal(await page.locator(".tile.type-song .full-badge").isVisible(), false,
      "no badge during a plain clip");
    const tBefore = (await audioState(page)).t;
    await page.locator(".tile.type-full").click();
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "full" });
    await page.waitForSelector(".tile.type-song.full-on .full-badge", { state: "visible" });
    assert.equal(await page.locator(".tile.type-song .full-badge").textContent(), "Full song ✓",
      "hero acknowledges full mode under the image");
    assert.ok(parseInt(await page.locator(".tile.type-song .full-badge")
      .evaluate((el) => getComputedStyle(el).fontSize)) >= 60, "badge at reading size (dad r4)");
    assert.ok(parseInt(await page.locator(".tile.type-song .tile-label.plate")
      .evaluate((el) => el.dataset.fontPx)) >= 74, "hero title at reading size (dad r4)");
    assert.ok(await page.locator(".tile.type-full.active").count() === 1,
      "the Full song tile goes active too");
    await page.waitForTimeout(400);
    const s2 = await audioState(page);
    assert.equal(s2.paused, false, "still playing after Full song");
    assert.ok(s2.t > tBefore, `no restart (t ${tBefore.toFixed(2)} -> ${s2.t.toFixed(2)})`);
    await waitSilent(page, 6000);   // natural end of the 3s fixture song
    const s3 = await audioState(page);
    assert.ok(s3.t > 2.5 || s3.paused, "played past the clip cap to the real end");
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "done" });
    assert.equal(await page.locator(".tile.type-song.full-on").count(), 0,
      "badge clears when the song ends");

    // ---- hero is gaze-safe while playing: activation = NO-OP (dad r5) ----
    await page.locator(".tile.type-song").click();      // fresh clip from silence
    await waitPlaying(page, first);
    await page.waitForFunction(() => window.Music._audio.currentTime > 0.3);
    const evCount = musicEvents.length;
    const tA = (await audioState(page)).t;
    await page.locator(".tile.type-song").click();      // she looks at the art
    await page.waitForTimeout(250);
    const sB = await audioState(page);
    assert.equal(sB.paused, false, "still playing after a hero gaze");
    assert.ok(sB.t >= tA, `no restart (${tA.toFixed(2)} -> ${sB.t.toFixed(2)})`);
    assert.equal(musicEvents.length, evCount, "a no-op posts no event");

    // ---- Stop remembers the spot; the hero RESUMES from it (dad r5) ----
    await page.locator(".tile.type-stop").click();
    await waitSilent(page);
    assert.equal(await onBoard(page), "song-" + first, "Stop does not navigate");
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "stop" });
    const tStop = (await audioState(page)).t;
    assert.ok(tStop > 0.2, "paused mid-clip with position kept");
    await page.locator(".tile.type-song").click();      // hero: resume, not restart
    await waitPlaying(page, first);
    const sR = await audioState(page);
    assert.ok(sR.t >= tStop - 0.05, `resumed from the spot (${tStop.toFixed(2)} -> ${sR.t.toFixed(2)})`);

    // ---- back arrow: leaves the page AND stops the music ----
    await page.locator(".tile.type-back").click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-all");
    await waitSilent(page);
    assert.equal((await audioState(page)).paused, true,
      "leaving the song page stops playback (why the grid needs no Stop)");
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "stop" });

    // ---- grid page 2 of All: 3 remaining songs; More loops; rail Back ----
    await page.locator('.tile.type-control:has-text("More")').click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-all-2");
    assert.equal(await page.locator(".tile.type-song").count(), 3, "the rest of All on page 2");
    const page2 = await gridSongs(page);
    assert.equal(new Set([...page1, ...page2]).size, 12, "every song once across the section's pages");
    const back2 = page.locator('.rail .tile[aria-label="Back"]');
    assert.equal(await back2.getAttribute("data-dwell-disabled"), null, "Back is live on page 2");
    assert.ok(await back2.evaluate((el) => el.classList.contains("dwell")), "…and a gaze target");
    // a song page opened from page 2 returns to page 2
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, page2[0]);
    await page.locator(".tile.type-back").click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-all-2");
    await waitSilent(page);
    assert.equal(await page.locator('.rail .tile.is-current').getAttribute("aria-label"), "All");
    await page.locator('.tile.type-control:has-text("More")').click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-all", null, { timeout: 4000 });
    assert.deepEqual(await gridSongs(page), page1, "More on the last page loops to page 1, same order");
    await page.locator('.tile.type-control:has-text("More")').click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-all-2");
    await back2.click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-all");

    // ---- sections: New lists every song; Top hits / Disney have none here ----
    await page.locator('.rail .tile[aria-label="New"]').click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-new");
    assert.equal(await page.locator('.rail .tile.is-current').getAttribute("aria-label"), "New");
    assert.equal(await page.locator(".tile.type-song").count(), 9);
    // a song page opened from New returns to New, not All
    const fromNew = (await gridSongs(page))[0];
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, fromNew);
    await page.locator(".tile.type-back").click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-new");
    await waitSilent(page);
    await page.locator('.rail .tile[aria-label="Disney"]').click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-disney");
    assert.equal(await page.locator(".tile.type-song").count(), 0, "the fixture has no Disney songs");
    assert.equal(await page.locator(".board-area .cell.rest").count(), 12, "an empty section is one page of black cells");
    assert.equal(await page.locator(".tile.type-control").count(), 0, "…with no More");
    await page.locator('.rail .tile[aria-label="All"]').click();
    await page.waitForFunction(() => window.Board.session.currentId === "songs-all");

    // ---- offline: cached songs still open their page and play the clip ----
    await page.waitForFunction(() => window.__musicCached !== null, null, { timeout: 30000 });
    const cached = await page.evaluate(() => window.__musicCached);
    assert.equal(cached.cached, cached.total, "prefetch cached every song");
    await ctx.setOffline(true);
    await page.locator(".tile.type-song").nth(2).click();
    await waitPlaying(page, page1[2]);
    assert.equal(await onBoard(page), "song-" + page1[2]);
    await ctx.setOffline(false);
  } finally { await browser.close(); }
});

test("?vol= caps the player's loudness (classroom bat passes vol=20)", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
    await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
    const page = await ctx.newPage();
    await page.goto(BASE + "&vol=20", { waitUntil: "load" });
    await page.waitForFunction(() => window.Music, null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.Music._audio.volume), 0.2, "vol=20 -> 20% loudness");
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => { window.__musicTest = { capPollMs: 300 }; });
    await p2.goto(BASE, { waitUntil: "load" });
    await p2.waitForFunction(() => window.Music, null, { timeout: 8000 });
    assert.equal(await p2.evaluate(() => window.Music._audio.volume), 1, "no param -> full volume (home)");
    // live-follow: the ERAgaze Settings knob reaches an OPEN board (no relaunch)
    await p2.route("**/settings", (r) => r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ musicVolCap: 25 }),
    }));
    await p2.waitForFunction(() => window.Music._audio.volume === 0.25, null, { timeout: 8000 });
    await p2.close();   // its live-follow poll writes the shared localStorage cache
    // offline resiliency: the last server cap is remembered; a dead /settings
    // must never mean full-volume music in a classroom
    const p3 = await ctx.newPage();
    await p3.route("**/settings", (r) => r.abort());
    await p3.route("**/music-event", (r) => r.fulfill({ status: 204, body: "" }));
    await p3.addInitScript(() => { try { localStorage.setItem("music:volCap", "50"); } catch {} });
    await p3.goto(BASE, { waitUntil: "load" });
    await p3.waitForFunction(() => window.Music, null, { timeout: 8000 });
    assert.equal(await p3.evaluate(() => window.Music._audio.volume), 0.5,
      "settings dead -> cached cap holds");
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


test("song pictures: ten frames cycle without restarting music, work offline, and can be reviewed by a parent", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, musicEvents } = await makePage(browser, true);
    const first = (await gridSongs(page))[0];
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, first);
    await page.evaluate(() => { window.Music._audio.playbackRate = 0.1; });
    const hero = page.locator(".tile.type-song");
    await page.waitForFunction(() => document.querySelector(".tile.type-song").dataset.pictureIndex === "0");
    await page.locator(".tile.type-full").click();
    const before = await audioState(page), events = musicEvents.length;
    for (let i = 1; i < 10; i++) {
      await hero.click();
      await page.waitForFunction(index => document.querySelector(".tile.type-song").dataset.pictureIndex === String(index), i);
    }
    const after = await audioState(page);
    assert.equal(after.paused, false);
    assert.ok(after.t >= before.t, "pictures never rewind audio");
    assert.equal(musicEvents.length, events, "picture changes emit no playback events");
    assert.equal(await page.evaluate(() => window.Music.isFull()), true, "full-song mode preserved");
    await page.waitForFunction(() => window.__musicCached !== null);
    await ctx.setOffline(true);
    await hero.click();
    await page.waitForFunction(() => document.querySelector(".tile.type-song").dataset.pictureIndex === "0");
    for (let i = 1; i < 10; i++) {
      await hero.click();
      await page.waitForFunction(index => document.querySelector(".tile.type-song").dataset.pictureIndex === String(index), i);
    }
    await ctx.setOffline(false);
    // A parked gaze advances once; a new look after moving re-arms it.
    await page.mouse.move(5, 5);
    await hero.evaluate(el => { el.dataset.dwellMs = "180"; });
    const box = await hero.boundingBox();
    await page.waitForTimeout(600);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector(".tile.type-song").dataset.pictureIndex === "0");
    await page.waitForTimeout(650);
    assert.equal(await hero.getAttribute("data-picture-index"), "0", "stationary gaze does not spin through the set");
    await page.mouse.move(5, 5);
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector(".tile.type-song").dataset.pictureIndex === "1");
    await page.locator("#stripPictures").click();
    assert.equal(await page.locator(".song-pictures img").count(), 10);
    assert.equal(await page.locator("#partnerSheet .dwell").count(), 0, "review is touch only");
    let pictureRequest;
    await ctx.route("**/music/pictures", route => {
      pictureRequest = route.request().postDataJSON();
      return route.fulfill({ status: 409, contentType: "application/json", body: '{"message":"Test preview"}' });
    });
    await page.locator("#pictureVideoLink").fill("https://www.youtube.com/watch?v=picture-video");
    await page.getByRole("button", { name: "Get video pictures" }).click();
    await page.waitForFunction(() => document.querySelector("#sheetSay").textContent === "Test preview");
    assert.deepEqual(pictureRequest, { id: first, clear: false, url: "https://www.youtube.com/watch?v=picture-video" });
    assert.equal(await page.locator(".tile.dwell").count(), 0, "covered tiles cannot activate through the review");
    await page.locator("#sheetClose").click();
    assert.equal(await page.locator(".tile.dwell").count(), 4);
    await page.screenshot({ path: "/tmp/music-recruitment-song.png" });
    await ctx.close();
  } finally { await browser.close(); }
});

test("Full song from silence is a fresh pick; Stop and the clip tell themselves apart", async () => {
  const browser = await chromium.launch();
  try {
    const { page, musicEvents } = await makePage(browser);
    const first = (await gridSongs(page))[0];
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, first);
    await page.locator(".tile.type-stop").click();
    await waitSilent(page);
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "stop" });
    await page.locator(".tile.type-full").click();          // from silence: a new pick, full
    await waitPlaying(page, first);
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "full", fresh: true });
    await waitSilent(page, 6000);
    assert.deepEqual(musicEvents.at(-1), { songId: first, action: "done" });
  } finally { await browser.close(); }
});

// The order is fixed when the recipe is BUILT (spec "Calls made"): a pick moves
// the hub's ETag order part (`~o<hash>`), and a board on screen must not
// reload for it, or the tiles would move under her gaze. A content change (a
// new song, a section a parent set) still reloads once she is idle — but never
// while a song is playing.
test("a board on screen never reloads for a new order; content still reloads when idle and silent", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
    await ctx.route("**/music-event", (r) => r.fulfill({ status: 204, body: "" }));
    await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
    await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
    let served = null, heads = 0, gets = 0;
    let headTag = (tag) => tag;
    await ctx.route("**/recipes/songs.json", async (route) => {
      if (route.request().method() === "HEAD") {
        heads++;
        return route.fulfill({ status: 200, headers: { etag: headTag(served) }, body: "" });
      }
      gets++;
      const response = await route.fetch();
      served = response.headers()["etag"];
      return route.fulfill({ response });
    });
    await ctx.addInitScript(() => {
      window.__testHooks = true;
      window.__musicTest = { clipMs: 1500 };
      window.__boardTest = { pollMs: 150, retryMs: 150, idleMs: 0 };
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForFunction(() => window.Board && window.Music, null, { timeout: 8000 });
    assert.match(served, /~o[0-9a-f]+"$/, "the hub's ETag carries an order part");
    await page.evaluate(() => { window.__stillHere = true; });

    headTag = (tag) => tag.replace(/~o[0-9a-f]+"$/, '~o000000000000"');   // only the order moved
    const h0 = heads;
    await page.waitForTimeout(1200);
    assert.ok(heads > h0 + 2, "the watcher kept asking");
    assert.equal(await page.evaluate(() => window.__stillHere === true), true, "no reload for an order change");
    assert.equal(gets, 1, "and no new recipe fetched");

    // content moved, but a song is playing: wait for silence
    await page.locator(".tile.type-song").first().click();
    await page.waitForFunction(() => window.Music.isPlaying());
    headTag = (tag) => tag.replace(/^"\d+/, '"1');
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => window.__stillHere === true), true, "never reloads under a playing song");
    await page.waitForFunction(() => !window.__stillHere, null, { timeout: 8000 });   // the clip ends, then it reloads
    assert.equal(gets, 2, "the reload fetched the recipe again");
    await ctx.close();
  } finally { await browser.close(); }
});

// Geometry at her two screen sizes: the rail and the grid fit under the bar,
// nothing overlaps, labels hold the 74 floor unless marked fit-impossible, the
// centre stays black. ERA_SHOTS names a directory for screenshots.
test("rail and grid fit at 1920x1080 and 1280x720", async () => {
  const shots = process.env.ERA_SHOTS || null;
  const browser = await chromium.launch();
  try {
    for (const [w, h] of [[1920, 1080], [1280, 720]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
      await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
      await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
      const page = await ctx.newPage();
      await page.goto(BASE, { waitUntil: "load" });
      await page.waitForFunction(() => window.Board, null, { timeout: 8000 });
      await page.evaluate(() => window.Board.show("songs-all"));
      await page.waitForTimeout(150);
      const g = await page.evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
        const bar = document.querySelector(".msgbar").getBoundingClientRect().bottom;
        const rail = [...document.querySelectorAll(".rail > .tile")].map((el) => ({ ...box(el),
          font: +el.querySelector(".tile-label").dataset.fontPx, reduced: !!el.querySelector(".tile-label").dataset.fontReduced,
          over: el.querySelector(".tile-label").scrollWidth > el.querySelector(".tile-label").clientWidth + 1 }));
        const cells = [...document.querySelectorAll(".board-area [data-cell]")].map((el) => ({ ...box(el), cell: el.dataset.cell,
          rest: el.classList.contains("rest"), bg: getComputedStyle(el).backgroundColor }));
        return { bar, rail, cells, vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth };
      });
      assert.equal(g.rail.length, 6);
      assert.equal(g.cells.length, 12, "twelve grid cells");
      assert.ok(g.scrollW <= g.vw, "no horizontal scroll");
      const all = [...g.rail, ...g.cells];
      for (const b of all) {
        assert.ok(b.t >= g.bar - 0.5, `below the door bar at ${w}x${h}`);
        assert.ok(b.b <= g.vh + 0.5 && b.r <= g.vw + 0.5 && b.l >= -0.5, `on screen at ${w}x${h}`);
      }
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        const overlap = Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
        assert.ok(!overlap, `no two tiles overlap at ${w}x${h}`);
      }
      const railRight = Math.max(...g.rail.map((b) => b.r)), gridLeft = Math.min(...g.cells.map((b) => b.l));
      assert.ok(gridLeft - railRight >= 13.5, "the contract gap between rail and grid");
      assert.ok(Math.abs(g.rail[0].t - Math.min(...g.cells.map((b) => b.t))) < 1 &&
                Math.abs(g.rail[5].b - Math.max(...g.cells.map((b) => b.b))) < 1, "the rail fills the grid's height");
      for (const r of g.rail) {
        assert.ok(!r.over, "no rail label overflows");
        assert.ok(r.font >= 74 || r.reduced, `rail label >= 74px or marked fit-impossible (${r.font}px at ${w}x${h})`);
      }
      for (const c of g.cells.filter((c) => c.cell === "2,2" || c.cell === "2,3"))
        assert.ok(c.rest && c.bg === "rgb(0, 0, 0)", "centre black");
      if (shots) await page.screenshot({ path: `${shots}/songs-rail-${w}x${h}.png` });
      await ctx.close();
    }
  } finally { await browser.close(); }
});

test("a parent sets a song's section from the touch-only sheet", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser);
    let sent = null;
    await ctx.route("**/music/category", (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, id: sent.id, category: sent.category, mirrored: true }) });
    });
    const first = (await gridSongs(page))[0];
    await page.locator(".tile.type-song").first().click();
    await waitPlaying(page, first);
    await page.locator("#stripPictures").click();
    const choices = page.locator("#partnerSheet .song-category button");
    assert.deepEqual(await choices.allTextContents(), ["Top hits", "Disney", "Neither"]);
    assert.equal(await page.locator("#partnerSheet .dwell, #partnerSheet [data-dwell-ms]").count(), 0, "touch only");
    assert.equal(await page.locator('#partnerSheet .song-category button[aria-pressed="true"]').textContent(), "Neither",
      "the fixture's songs are in neither");
    await page.locator("#partnerSheet .song-category button", { hasText: "Disney" }).click();
    await page.waitForFunction(() => document.querySelector('#partnerSheet .song-category button[aria-pressed="true"]')?.textContent === "Disney");
    assert.deepEqual(sent, { id: first, category: "disney" });
    await page.locator("#partnerSheet .song-category button", { hasText: "Neither" }).click();
    await page.waitForFunction(() => document.querySelector('#partnerSheet .song-category button[aria-pressed="true"]')?.textContent === "Neither");
    assert.deepEqual(sent, { id: first, category: null });
    await ctx.close();
  } finally { await browser.close(); }
});
