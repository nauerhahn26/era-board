// board-movies.test.mjs — Movies Board (movie-player spec 8/29, board side §5).
// The board renders poster tiles and LAUNCHES the streaming app via ERAgaze
// (POST 127.0.0.1:49155/app/launch) — it never plays video itself. This suite
// drives the test server's /board/?recipe=movies with the hub's movies recipe
// STUBBED at the network layer (playwright route): the hub generator lands in
// its own worktree, so the fixture below IS the cell contract the generator
// must emit — show doors (board:), movie tiles (titleId/service/url), episode
// tiles (episode:{s,e}, mark:"next"|"again"). ERAgaze endpoints are stubbed
// the same way (49155 is never running in CI).
// Runs under `node --test` or `node tests/board-movies.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/?recipe=movies";

// ---- the fixture recipe: EXACTLY the cell contract the hub generator emits.
// show door -> its show board; movie -> deep-link launch; episode -> launch
// with {s,e}; back/more/exit/rest unchanged. One movie carries image:null
// (text-only fallback); the what-next board is the post-episode choice point.
const FIXTURE = {
  locale: "en-US", root: "movies", home_label: "Movies",
  boards: [
    { id: "movies", name: "What do I want to watch?", rows: 3, columns: 4,
      buttons: [
        { type: "show", label: "Bluey", image: "movies/bluey.jpg",
          board: "show-bluey", row: 1, col: 1 },
        { type: "movie", label: "Moana", image: "movies/moana.jpg",
          titleId: "moana", service: "disney",
          url: "https://www.disneyplus.com/play/moana-uuid", row: 1, col: 2 },
        { type: "movie", label: "Frozen", image: null,
          titleId: "frozen", service: "disney",
          url: "https://www.disneyplus.com/play/frozen-uuid", row: 1, col: 3 },
        { label: "More", type: "control", symbol: "more",
          load: "movies-2", row: 3, col: 1 },
      ] },
    { id: "movies-2", name: "What do I want to watch?", rows: 3, columns: 4,
      buttons: [
        { label: "Back", say: "back", type: "back", glyph: "←",
          load: "movies", row: 1, col: 1 },
        { type: "movie", label: "Ponyo", image: "movies/ponyo.jpg",
          titleId: "ponyo", service: "netflix",
          url: "https://www.netflix.com/watch/70106454", row: 1, col: 2 },
      ] },
    { id: "show-bluey", name: "Bluey", rows: 3, columns: 4,
      buttons: [
        { label: "Back", say: "back", type: "back", glyph: "←",
          load: "movies", row: 1, col: 1 },
        { type: "episode", label: "Magic Xylophone", titleId: "bluey",
          service: "disney", url: "https://www.disneyplus.com/play/bluey-s1e1",
          episode: { s: 1, e: 1 }, mark: "again", row: 1, col: 2 },
        { type: "episode", label: "Hospital", titleId: "bluey",
          service: "disney", url: "https://www.disneyplus.com/play/bluey-s1e2",
          episode: { s: 1, e: 2 }, mark: "next", row: 1, col: 3 },
        { type: "episode", label: "Keepy Uppy", titleId: "bluey",
          service: "disney", url: "https://www.disneyplus.com/play/bluey-s1e3",
          episode: { s: 1, e: 3 }, row: 2, col: 2 },
      ] },
    // the AAC choice point that replaces autoplay (spec: next episode /
    // watch again / all done / something else). Exit sits bottom-right per
    // the anchor law; unpinned cells become black rests (never-empty rows).
    { id: "show-bluey-next", name: "What next?", rows: 2, columns: 3,
      buttons: [
        { type: "episode", label: "Next episode", titleId: "bluey",
          service: "disney", url: "https://www.disneyplus.com/play/bluey-s1e3",
          episode: { s: 1, e: 3 }, mark: "next", row: 1, col: 1 },
        { type: "episode", label: "Watch again", titleId: "bluey",
          service: "disney", url: "https://www.disneyplus.com/play/bluey-s1e2",
          episode: { s: 1, e: 2 }, mark: "again", row: 1, col: 2 },
        { label: "Something else", type: "control", symbol: "more",
          load: "movies", row: 2, col: 1 },
        { label: "All done", say: "all done", type: "exit", row: 2, col: 3 },
      ] },
  ],
};

// 1x1 JPEG — enough for the <img> poster path (the real /movies/ static jail
// lands hub-side; posters here only need to resolve).
const JPG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64");

const ETAG = '"movies-fixture-1"';

// Hermetic page: recipe + posters + ERAgaze + telemetry all stubbed at the
// network layer BEFORE the page loads (board-music harness pattern).
async function makePage(browser, { launchStatus = 200 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    hasTouch: true,
  });
  const launches = [];  // /app/launch payloads ERAgaze would receive
  const events = [];    // /movie-event payloads the hub pool would receive
  const state = { launchStatus };
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/movies/*.jpg", (r) =>
    r.fulfill({ status: 200, contentType: "image/jpeg", body: JPG }));
  await ctx.route("**/recipes/movies.json", (r) => {
    const headers = { "Content-Type": "application/json", "ETag": ETAG,
                      "Cache-Control": "no-cache" };
    if (r.request().method() === "HEAD") { r.fulfill({ status: 200, headers, body: "" }); return; }
    r.fulfill({ status: 200, headers, body: JSON.stringify(FIXTURE) });
  });
  await ctx.route("http://127.0.0.1:49155/app/launch", (r) => {
    if (state.launchStatus === 0) { r.abort("connectionrefused"); return; }
    if (state.launchStatus === 200) launches.push(r.request().postDataJSON());
    r.fulfill({ status: state.launchStatus, body: "" });
  });
  await ctx.route("**/movie-event", (r) => {
    events.push(r.request().postDataJSON());
    r.fulfill({ status: 204, body: "" });
  });
  await ctx.addInitScript(() => { window.__testHooks = true; });  // Speech spy
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  return { ctx, page, launches, events, state };
}

const log = (page) => page.evaluate(() => window.__speechLog.slice());
const resetLog = (page) => page.evaluate(() => { window.__speechLog.length = 0; });
const onBoard = (page) => page.evaluate(() => window.Board.session.currentId);

test("movies board: posters, show door, launch + watching marker, More/back/rest", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches, events } = await makePage(browser);

    // ---- grid page 1: poster tiles ride the photo path ----
    const showTile = page.locator(".tile.type-show");
    assert.equal(await showTile.count(), 1, "one show door");
    assert.ok(await showTile.evaluate((el) => el.classList.contains("photo")),
      "show poster rides the photo path");
    assert.ok((await showTile.locator("img.photo-img").getAttribute("src")).endsWith("/movies/bluey.jpg"),
      "poster served from the /movies/ jail");
    assert.equal(await showTile.locator(".tile-label.plate").textContent(), "Bluey");
    const moana = page.locator('.tile.type-movie:has-text("Moana")');
    assert.ok(await moana.evaluate((el) => el.classList.contains("photo")),
      "movie poster rides the photo path too");
    // null-image movie: TEXT tile at contract font sizes, centered (stacked)
    const frozen = page.locator('.tile.type-movie:has-text("Frozen")');
    assert.ok(await frozen.evaluate((el) => !el.classList.contains("photo") && el.classList.contains("stacked")),
      "poster-less movie falls back to a stacked text tile");
    assert.equal(await frozen.locator("img").count(), 0, "no image element");
    assert.ok(parseInt(await frozen.locator(".tile-label").evaluate((el) => el.dataset.fontPx)) >= 74,
      "text fallback label at the 74px contract floor");
    // rest spots: every empty cell is a black inert rest, aria-hidden
    assert.equal(await page.locator(".cell.rest").count(), 8, "8 rest cells fill the 3x4 grid");
    assert.equal(await page.locator('.cell.rest[aria-hidden="true"]').count(), 8, "rests are aria-hidden");
    // launch tiles carry the deliberate nav-tier hold (leaving the board for
    // another app >= a nav door; content default would be too quick)
    assert.ok(parseInt(await moana.evaluate((el) => el.dataset.dwellMs)) >= 1600,
      "movie launch hold is nav-tier");
    assert.ok(parseInt(await showTile.evaluate((el) => el.dataset.dwellMs)) >= 1600,
      "show door hold is nav-tier");

    // ---- show door: navigates (door semantics), silent, NO launch/event ----
    await resetLog(page);
    await showTile.click();
    // settle-suppression on the fresh page (27P #5b): dwell must be suppressed
    // (checked immediately — the 250ms window is still open right after click)
    const sup = await page.evaluate(() => window.Dwell.state().suppressedMs);
    assert.ok(sup > 0, `page change suppresses dwell arming (suppressedMs=${sup})`);
    assert.equal(await onBoard(page), "show-bluey", "show door opens the show board");
    assert.deepEqual(await log(page), [{ call: "stop" }], "show door is silent (barge-in stop only)");
    assert.equal(launches.length, 0, "a door never launches");
    assert.equal(events.length, 0, "a door posts no movie-event");

    // ---- episode page: marks ----
    assert.equal(await page.locator(".tile.type-episode").count(), 3, "three episode tiles");
    assert.equal(await page.locator(".tile.mark-next").count(), 1, "next-unwatched wears mark-next");
    assert.ok(await page.locator('.tile.mark-next:has-text("Hospital")').count() === 1,
      "mark-next sits on the right episode");
    assert.equal(await page.locator(".tile.mark-again").count(), 1, "last-watched wears mark-again");

    // ---- episode activation: Speech.stop FIRST, /app/launch payload, event ----
    await resetLog(page);
    await page.locator('.tile.type-episode:has-text("Keepy Uppy")').click();
    await page.waitForSelector(".tile.watching", { timeout: 4000 });
    assert.deepEqual(await log(page), [{ call: "stop" }],
      "launch is silent — the video is the response (barge-in stop only)");
    assert.equal(launches.length, 1, "one launch POST");
    assert.deepEqual(launches[0], {
      url: "https://www.disneyplus.com/play/bluey-s1e3",
      watch: true, titleId: "bluey", episode: { s: 1, e: 3 },
    }, "episode launch payload matches the ERAgaze contract");
    assert.deepEqual(events, [{ titleId: "bluey", service: "disney",
      episode: { s: 1, e: 3 }, action: "launch" }],
      "movie-event fired to the hub pool");
    assert.ok(await page.locator('.tile.watching:has-text("Keepy Uppy")').count() === 1,
      "the launched tile wears .watching");

    // ---- the marker survives page nav (applyPlaying-style re-apply) ----
    await page.locator(".tile.type-back").click();
    assert.equal(await onBoard(page), "movies");
    assert.equal(await page.locator(".tile.watching").count(), 0, "marker is page-local");
    await page.locator(".tile.type-show").click();
    assert.ok(await page.locator('.tile.watching:has-text("Keepy Uppy")').count() === 1,
      "back on the show board the marker is still there");

    // ---- a new successful launch MOVES the marker ----
    await page.locator('.tile.type-episode:has-text("Hospital")').click();
    await page.waitForFunction(() =>
      document.querySelectorAll(".tile.watching").length === 1 &&
      document.querySelector(".tile.watching").textContent.includes("Hospital"));
    assert.equal(launches.length, 2);
    assert.deepEqual(launches[1].episode, { s: 1, e: 2 });

    // ---- movie launch from the grid: no episode field ----
    await page.locator(".tile.type-back").click();
    await page.locator('.tile.type-movie:has-text("Moana")').click();
    await page.waitForFunction(() =>
      document.querySelector(".tile.watching") &&
      document.querySelector(".tile.watching").textContent.includes("Moana"));
    assert.deepEqual(launches[2], {
      url: "https://www.disneyplus.com/play/moana-uuid",
      watch: true, titleId: "moana",
    }, "movie payload carries no episode");
    assert.deepEqual(events[2], { titleId: "moana", service: "disney", action: "launch" });

    // ---- More / back paging (unchanged types keep working) ----
    await page.locator('.tile.type-control:has-text("More")').click();
    assert.equal(await onBoard(page), "movies-2", "More pages forward");
    assert.equal(await page.locator(".tile.type-movie").count(), 1, "page 2 movie renders");
    await page.locator(".tile.type-back").click();
    assert.equal(await onBoard(page), "movies", "back returns to page 1");
    await ctx.close();
  } finally { await browser.close(); }
});

test("what-next board: deep link, four choices — next launches, something-else navigates, all-done exits", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches } = await makePage(browser);
    let exitHits = 0;   // the hub's exit choke point (it talks to ERAgaze itself)
    await ctx.route("**/kiosk/exit", (r) => { exitHits++; r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"closed"}' }); });

    // the ?board= anchor (spec §5): ERAgaze reveals the picker on the show's
    // what-next page after an episode ends.
    await page.goto(BASE + "&board=show-bluey-next", { waitUntil: "load" });
    await page.waitForFunction(() => window.Board && window.Board.session.currentId === "show-bluey-next", null, { timeout: 8000 });
    assert.equal(await page.locator(".tile").count(), 4, "four choices, nothing else");
    assert.equal(await page.locator(".cell.rest").count(), 2, "empty cells are rests (bottom row never empty)");

    // next episode -> launch with the right payload
    await page.locator('.tile.mark-next:has-text("Next episode")').click();
    await page.waitForSelector(".tile.watching", { timeout: 4000 });
    assert.deepEqual(launches.at(-1), {
      url: "https://www.disneyplus.com/play/bluey-s1e3",
      watch: true, titleId: "bluey", episode: { s: 1, e: 3 },
    }, "next-episode launches the next episode");
    assert.equal(await onBoard(page), "show-bluey-next", "launch does not navigate the board");

    // watch again is a live launch tile too (rewatch = comprehension win)
    await page.locator('.tile.mark-again:has-text("Watch again")').click();
    await page.waitForFunction(() =>
      document.querySelector(".tile.watching") &&
      document.querySelector(".tile.watching").textContent.includes("Watch again"));
    assert.deepEqual(launches.at(-1).episode, { s: 1, e: 2 }, "watch-again relaunches the last-watched");

    // something else -> the main grid
    await page.locator('.tile.type-control:has-text("Something else")').click();
    assert.equal(await onBoard(page), "movies", "something-else opens the main picker");

    // all done -> the existing exit path (grid exit tile, 2400ms hold)
    await page.goto(BASE + "&board=show-bluey-next", { waitUntil: "load" });
    await page.waitForFunction(() => window.Board && window.Board.session.currentId === "show-bluey-next", null, { timeout: 8000 });
    const exitTile = page.locator(".tile.type-exit");
    assert.equal(await exitTile.evaluate((el) => el.dataset.dwellMs), "2400", "exit keeps the exit hold");
    await resetLog(page);
    await exitTile.click();
    await page.waitForTimeout(200);
    assert.equal(exitHits, 1, "all-done POSTs /kiosk/exit exactly once");
    assert.deepEqual(await log(page), [{ call: "stop" }], "exit is silent");
    assert.ok(await page.evaluate(() => !!window.Board), "no fallback navigation on a closed exit");
    await ctx.close();
  } finally { await browser.close(); }
});

test("49155 failure is graceful: calm flag, no marker, no event, board stays usable", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches, events, state } = await makePage(browser, { launchStatus: 0 }); // connection refused
    await page.evaluate(() => window.Board.show("show-bluey"));

    await resetLog(page);
    await page.locator('.tile.type-episode:has-text("Keepy Uppy")').click();
    await page.waitForSelector(".tile.launch-failed", { timeout: 4000 });
    assert.ok(await page.locator('.tile.launch-failed:has-text("Keepy Uppy")').count() === 1,
      "the picked tile wears the brief calm flag");
    assert.equal(await page.locator(".tile.watching").count(), 0, "no watching marker on failure");
    assert.equal(events.length, 0, "no movie-event on failure (history counts real launches only)");
    assert.deepEqual(await log(page), [{ call: "stop" }], "still silent — no error speech at her");
    // T7.6 bug 4 (VM QA 9/5): the flag says "refused", the partner banner says
    // WHY — a touch-only family that unticked ERAgaze otherwise has a Movies
    // app that never plays and never explains. Touch only, never a dwell target.
    const warn = page.locator("#launchWarn.show");
    await warn.waitFor({ timeout: 2000 });
    assert.match(await warn.textContent(), /ERAgaze/, "the banner names the thing that is missing");
    assert.match(await warn.textContent(), /Settings/, "and where a grown-up turns it on");
    assert.equal(await warn.evaluate((el) => el.classList.contains("dwell") || el.hasAttribute("data-dwell-ms")), false,
      "the banner is not a dwell target");
    assert.equal(await warn.evaluate((el) => getComputedStyle(el).pointerEvents), "none",
      "a tap on the banner falls through to the tile under it");
    // the flag clears on its own (~2s) and the board never crashed/reloaded
    await page.waitForFunction(() => !document.querySelector(".tile.launch-failed"), null, { timeout: 5000 });
    assert.ok(await page.evaluate(() => !!window.Board), "board alive after a dead ERAgaze");
    assert.equal(await page.locator("#launchWarn.show").count(), 1, "the banner outlives the 2 s flag — a parent needs time to read it");

    // a 500 from ERAgaze is the same graceful path
    state.launchStatus = 500;
    await page.locator('.tile.type-episode:has-text("Hospital")').click();
    await page.waitForSelector(".tile.launch-failed", { timeout: 4000 });
    assert.equal(await page.locator(".tile.watching").count(), 0, "500 -> still no marker");

    // caregiver rescue: ERAgaze comes back, the SAME tile now launches fine
    state.launchStatus = 200;
    await page.locator('.tile.type-episode:has-text("Keepy Uppy")').click();
    await page.waitForSelector(".tile.watching", { timeout: 4000 });
    assert.equal(launches.length, 1, "recovered launch goes through");
    assert.equal(await page.locator("#launchWarn.show").count(), 0, "a real launch clears the explanation");
    assert.deepEqual(events.at(-1), { titleId: "bluey", service: "disney",
      episode: { s: 1, e: 3 }, action: "launch" }, "recovered launch reports its event");
    await ctx.close();
  } finally { await browser.close(); }
});

// ---------------------------------------------------------------------------
// T5.4 — "+ Add" on the movies board: paste a link, or type a name and pick a
// row out of a search grid.
//
// The strip and its sheet are T4.4's (board-partner.js); this is the movies
// half of it, and everything the amendment costs is re-proved here rather than
// assumed: the grid a grown-up picks from is POINTER-ONLY, so a gaze parked on
// a poster for longer than the board's longest hold fills nothing, and the
// board underneath is asleep while the sheet is up.
//
// D57 is the other thing under test: the hub never serves video, so nothing in
// this feature may change what the board sends ERAgaze. The launch payload is
// pinned BYTE for byte below, header included — a Content-Type on that POST
// would turn a CORS simple request into a preflight the native listener does
// not answer, and the family's films would stop opening.
//
// Hermetic: /movies/add and /movies/lookup are stubbed at the network layer,
// so no key is spent, nothing leaves the machine, and TMDB is never called.
const QUIET_CLOTHING = { building: false, ingesting: null, photos: 3, cataloged: 3, aiConfigured: true };
const QUIET_CONTENT = { mode: "local", local: true, skipped: null, building: false, job: null,
                        queued: [], jobs: [], lastScan: null };
const TMDB_CREDIT = "Poster art from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.";

// What movies-lookup.js hands back (its own documented shape): a show that
// streams somewhere with a real deep link, and a film the family can see is on
// Disney+ but that Watchmode gave no link for — the "found on Netflix, no
// link" half of the design, which must still be addable.
const HITS = [
  { title: "Ada Twist, Scientist", year: 2021, tmdbId: 120001, tmdbType: "tv", kind: "show",
    poster: "https://image.tmdb.org/t/p/w500/ada.jpg", ageRating: "TV-Y",
    providers: [{ name: "Netflix", slug: "netflix", providerId: 8,
                  deepLink: "https://www.netflix.com/watch/81028771" }],
    providerRef: { watchmode: 1553527 }, similar: [155, 156] },
  { title: "Ada Lake", year: 2018, tmdbId: 120002, tmdbType: "movie", kind: "movie",
    poster: null, ageRating: null,
    providers: [{ name: "Disney+", slug: "disney", providerId: 337, deepLink: null }],
    providerRef: {} },
];

// A movies board with the strip's hub doors stubbed. `dial` turns what the hub
// answers; `posts` collects what the sheet actually sent.
async function sheetPage(browser, dial) {
  const d = Object.assign({
    add: { status: 200, body: { ok: true, id: "ada-twist-scientist", title: "Ada Twist, Scientist",
                                kind: "show", rank: 4, pending: false, mirrored: true,
                                poster: "posters/ada-twist-scientist.jpg", attribution: TMDB_CREDIT } },
    lookup: { status: 200, body: { ok: true, provider: "watchmode", region: "US",
                                   results: HITS, hint: "", attribution: TMDB_CREDIT } },
  }, dial || {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true });
  const adds = [], lookups = [], launches = [];
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/movie-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/clothing/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CLOTHING) }));
  await ctx.route("**/content/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUIET_CONTENT) }));
  await ctx.route("**/movies/*.jpg", (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: JPG }));
  // the search grid's posters come from TMDB's image host in the real world;
  // here they come from nowhere at all.
  await ctx.route("https://image.tmdb.org/**", (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: JPG }));
  await ctx.route("**/recipes/movies.json", (r) => {
    const headers = { "Content-Type": "application/json", "ETag": ETAG, "Cache-Control": "no-cache" };
    if (r.request().method() === "HEAD") { r.fulfill({ status: 200, headers, body: "" }); return; }
    r.fulfill({ status: 200, headers, body: JSON.stringify(FIXTURE) });
  });
  await ctx.route("**/movies/lookup", (r) => {
    lookups.push({ body: r.request().postDataJSON(), type: r.request().headers()["content-type"] || "" });
    r.fulfill({ status: d.lookup.status, contentType: "application/json", body: JSON.stringify(d.lookup.body) });
  });
  await ctx.route("**/movies/add", (r) => {
    adds.push({ body: r.request().postDataJSON(), type: r.request().headers()["content-type"] || "" });
    r.fulfill({ status: d.add.status, contentType: "application/json", body: JSON.stringify(d.add.body) });
  });
  await ctx.route("http://127.0.0.1:49155/app/launch", (r) => {
    launches.push({ raw: r.request().postData(), type: r.request().headers()["content-type"] });
    r.fulfill({ status: 200, body: "" });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__activateCount = 0;
    document.addEventListener("dwell:activate", () => { window.__activateCount++; }, true);
    window.__boardTest = { statusMs: 60 * 60 * 1000, busyMs: 60 * 60 * 1000,
                           pollMs: 60 * 60 * 1000, idleMs: 60 * 60 * 1000, retryMs: 300 };
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  return { ctx, page, adds, lookups, launches, errors };
}

const said = (page) => page.locator("#sheetSay").textContent();

test("movies sheet: a pasted link goes to /movies/add as {url}, and the tile is reported", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, adds, errors } = await sheetPage(browser, {
      add: { status: 200, body: { ok: true, id: "moana", title: "Moana", kind: "movie",
                                  rank: 7, pending: false, mirrored: true, poster: null, attribution: null } },
    });
    await page.locator("#stripAdd").click();
    await page.locator("#partnerSheet").waitFor();
    assert.equal(await page.locator("#partnerSheet .dwell").count(), 0, "the sheet is pointer-only");
    await page.fill("#sheetInput", "  https://www.disneyplus.com/browse/entity-abc  ");
    await page.locator("#sheetGo").click();
    await page.waitForFunction(() => /Moana is on the board/.test(document.getElementById("sheetSay").textContent),
                               null, { timeout: 4000 });
    assert.equal(adds.length, 1, "one POST /movies/add");
    assert.deepEqual(adds[0].body, { url: "https://www.disneyplus.com/browse/entity-abc" },
                     "a pasted link goes as {url}, trimmed — and nothing is searched");
    assert.ok(adds[0].type.startsWith("application/json"),
              "JSON, so the hub's own-door check lets it through");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("movies sheet: a typed name is SEARCHED, and the answers render as a grid a grown-up picks from", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, lookups, adds, errors } = await sheetPage(browser);
    await page.locator("#stripAdd").click();
    await page.fill("#sheetInput", "  ada twist  ");
    await page.locator("#sheetGo").click();
    await page.locator("#sheetResults .sheet-result").first().waitFor({ timeout: 4000 });

    assert.equal(lookups.length, 1, "one POST /movies/lookup");
    assert.deepEqual(lookups[0].body, { query: "ada twist" }, "a name goes as {query}, trimmed");
    assert.ok(lookups[0].type.startsWith("application/json"), "JSON, so the own-door check lets it through");
    assert.equal(adds.length, 0, "a search writes NOTHING — the pick does that");

    const cells = page.locator("#sheetResults .sheet-result");
    assert.equal(await cells.count(), HITS.length, "one cell per answer");
    const first = cells.nth(0);
    assert.equal(await first.locator(".sheet-title").textContent(), "Ada Twist, Scientist");
    assert.equal(await first.locator(".sheet-year").textContent(), "2021");
    assert.match(await first.locator(".sheet-where").textContent(), /Netflix/);
    assert.equal(await first.locator("img.sheet-poster").count(), 1, "the poster TMDB gave us");
    // a row with no art is still a row — the name is the tile
    const second = cells.nth(1);
    assert.equal(await second.locator("img.sheet-poster").count(), 0, "no art, no broken image");
    assert.equal(await second.locator(".sheet-title").textContent(), "Ada Lake");
    // TMDB's terms: the credit rides with the posters, in the hub's own words
    assert.equal(await page.locator("#sheetCredit").textContent(), TMDB_CREDIT);
    // and the grid is furniture to a gaze, exactly like the strip that opened it
    assert.equal(await page.locator("#sheetResults .dwell").count(), 0, "no gaze target in the grid");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("movies sheet: picking a row adds THAT title, with the provenance the search found", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, adds, errors } = await sheetPage(browser);
    await page.locator("#stripAdd").click();
    await page.fill("#sheetInput", "ada twist");
    await page.locator("#sheetGo").click();
    await page.locator("#sheetResults .sheet-result").first().waitFor({ timeout: 4000 });
    await page.locator("#sheetPick0").click();
    await page.waitForFunction(() => /is on the board/.test(document.getElementById("sheetSay").textContent),
                               null, { timeout: 4000 });
    assert.equal(adds.length, 1, "one POST /movies/add for the row that was picked");
    assert.deepEqual(adds[0].body, {
      url: "https://www.netflix.com/watch/81028771",
      title: "Ada Twist, Scientist", kind: "show", year: 2021, tmdbId: 120001,
      ageRating: "TV-Y", providerRef: { watchmode: 1553527 }, addedBy: "search",
    }, "the pick carries the deep link and the provenance, and nothing else");
    assert.ok(adds[0].type.startsWith("application/json"));
    // the grid is gone once a row is picked: one add per sheet
    assert.equal(await page.locator("#sheetResults .sheet-result").count(), 0, "the grid closes behind the pick");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("movies sheet: a row nobody can open is saved anyway, and the sheet says what is missing", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, adds } = await sheetPage(browser, {
      add: { status: 200, body: { ok: true, id: "ada-lake", title: "Ada Lake", kind: "movie",
                                  rank: 8, pending: true, mirrored: true, poster: null, attribution: null } },
    });
    await page.locator("#stripAdd").click();
    await page.fill("#sheetInput", "ada twist");
    await page.locator("#sheetGo").click();
    await page.locator("#sheetPick1").waitFor({ timeout: 4000 });
    await page.locator("#sheetPick1").click();
    await page.waitForFunction(() => /paste/i.test(document.getElementById("sheetSay").textContent),
                               null, { timeout: 4000 });
    assert.deepEqual(adds[0].body, {
      title: "Ada Lake", kind: "movie", year: 2018, tmdbId: 120002, addedBy: "search",
    }, "no link, so none is invented — and no empty provenance is sent either");
    assert.match(await said(page), /Ada Lake/, "the film the parent picked is named back to them");
    await ctx.close();
  } finally { await browser.close(); }
});

test("movies sheet: nothing found, and no key at all, both end at the paste box", async () => {
  const browser = await chromium.launch();
  try {
    const none = "New ERA can look films up by name once a grown-up adds a TMDB key in Settings. " +
                 "Until then, paste the film's link and the tile still goes up.";
    const { ctx, page, adds } = await sheetPage(browser, {
      lookup: { status: 200, body: { ok: true, provider: "none", region: "US", results: [], hint: none } },
    });
    await page.locator("#stripAdd").click();
    await page.fill("#sheetInput", "ada twist");
    await page.locator("#sheetGo").click();
    await page.waitForFunction((want) => document.getElementById("sheetSay").textContent.includes(want),
                               none, { timeout: 4000 });
    assert.equal(adds.length, 0, "an empty grid writes nothing");
    assert.equal(await page.locator("#sheetResults .sheet-result").count(), 0, "and draws no rows");
    assert.equal(await page.locator("#sheetGo").isDisabled(), false, "the parent can try again straight away");
    await ctx.close();
  } finally { await browser.close(); }
});

test("movies sheet: a gaze parked on the search grid activates nothing, and the board beneath is asleep", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await sheetPage(browser);
    const tile = page.locator(".board-area .tile.dwell").first();
    await tile.waitFor({ timeout: 8000 });
    const under = await tile.boundingBox();
    await page.locator("#stripAdd").click();
    await page.fill("#sheetInput", "ada twist");
    await page.locator("#sheetGo").click();
    await page.locator("#sheetPick0").waitFor({ timeout: 4000 });

    const frozen = await page.evaluate(() => ({
      dwellTiles: document.querySelectorAll(".board-area .tile.dwell").length,
      disabled: document.querySelectorAll(".board-area .tile[data-dwell-disabled]").length,
      tiles: document.querySelectorAll(".board-area .tile").length,
      doorDwell: !!document.querySelector(".bardoor.dwell"),
      sheetDwellAttrs: [...document.querySelectorAll("#partnerSheet, #partnerSheet *")]
        .flatMap((el) => [...el.attributes].map((a) => a.name))
        .filter((n) => n.startsWith("data-dwell")),
    }));
    assert.equal(frozen.dwellTiles, 0, "with the grid up, not one tile is a gaze target");
    assert.equal(frozen.disabled, frozen.tiles, "every tile says so in the attribute dwell.js reads");
    assert.equal(frozen.doorDwell, true, "the way out of the board is never taken away");
    assert.deepEqual(frozen.sheetDwellAttrs, [], "nothing in the sheet carries a dwell attribute");

    const box = await page.locator("#sheetPick0").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(2600);        // > the longest hold on the board (2400ms door)
    assert.equal(await page.evaluate(() => window.__activateCount), 0, "a parked gaze never picks a row");
    assert.equal(await page.locator(".dwell-active").count(), 0, "and no dwell fill starts on the grid");
    await page.mouse.move(under.x + under.width / 2, under.y + under.height / 2);
    await page.waitForTimeout(2600);
    assert.equal(await page.evaluate(() => window.__activateCount), 0, "nor on the film beneath it");
    await ctx.close();
  } finally { await browser.close(); }
});

// D57: the hub never serves video, so the sheet may not have changed one byte
// of what leaves for ERAgaze. Pinned literally — the body AND the absent
// Content-Type, which is what keeps this a CORS simple request.
test("the launch payload is byte-identical: the sheet changed nothing about how a film opens", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, launches } = await sheetPage(browser);
    await page.locator('.tile.type-movie:has-text("Moana")').click();
    await page.waitForSelector(".tile.watching", { timeout: 4000 });
    assert.equal(launches.length, 1, "one launch POST");
    assert.equal(launches[0].raw,
      '{"url":"https://www.disneyplus.com/play/moana-uuid","watch":true,"titleId":"moana"}',
      "the launch body, byte for byte");
    assert.ok(!/application\/json/.test(launches[0].type || ""),
      "no JSON content-type: a preflight ERAgaze does not answer would kill every film");
    await ctx.close();
  } finally { await browser.close(); }
});
