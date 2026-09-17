// board-splash-door.test.mjs — the waiting screen keeps the door. Dad 9/3:
// "While the clothing picker is building it should still have the door exit,
// otherwise no way to return back to New ERA." The splash used to carry zero
// dwell targets for the minutes a 40-photo ingest takes; now it wears the same
// door strip the board does, and the door's fallback (no engine, or New ERA
// chosen in Settings) lands on /home/. Network-stubbed like the coach suite; drives the live server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/";

async function makePage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/recipes/today.json", (r) => r.fulfill({ status: 404, body: "not found" }));
  await ctx.route("**/clothing/status", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ building: false, ingesting: { done: 3, total: 40 }, cataloged: 3, photos: 40, aiConfigured: true }) }));
  // /kiosk/exit is NOT stubbed: the live hub answers {action:"home"} on a box
  // with no engine, which is exactly the fallback this suite is about.
  await ctx.route("http://127.0.0.1:49155/**", (r) => r.abort());   // no engine on a test box
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".splash");
  return { ctx, page };
}

test("the building screen has the door, top-left, sized like the board's own", async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await makePage(browser);
    await page.waitForFunction(() => /Building/.test(document.querySelector(".splash").textContent));
    const door = page.locator("#barDoor.bardoor.dwell");
    await door.waitFor();
    const box = await door.boundingBox();
    assert.ok(box, "door is laid out");
    assert.ok(box.x < 40 && box.y < 40, `door sits in the top-left corner, got ${box.x},${box.y}`);
    assert.ok(box.height >= 24 && box.width >= 2 * box.height - 2, "door is the strip-high, double-wide chrome");
    // AMENDED 9/17 (dad's two-speeds ruling, spec §5.1): the door holds TWICE
    // HER OWN Settings dwell, not a fixed 2400 — read it from the hub the page
    // read rather than restating a number here.
    const dwell = (await (await fetch(new URL("/settings", BASE))).json()).dwellMs;
    assert.equal(await door.getAttribute("data-dwell-ms"), String(2 * dwell),
                 `exit hold is 2 x her dwell (${dwell}ms)`);
    // Unchanged by the 9/4 amendment (T4.4) and checked because of it: the
    // partner strip is pointer-only and the CLOTHING splash never wears it (the
    // songs/movies splash does since 9/5 — board-partner-strip.test), so the
    // building screen's dwell targets are the two doors and nothing else.
    // 💬 is in the DOM on every screen and only SHOWS where /settings says
    // pauseGoes:"tdsnap"; this box has no engine, so it is hidden here.
    assert.deepEqual(await page.locator(".dwell").evaluateAll((els) => els.map((e) => e.id)),
                     ["barDoor", "barTalk"], "the two doors are the splash's only dwell targets");
    assert.equal(await page.locator("#barTalk:visible").count(), 0, "and with no engine, only 🚪 is on screen");
    assert.equal(await page.locator("#partnerStrip").count(), 0, "no partner strip on the building screen");
    // the text still fits under the strip — nothing spills off screen
    const sb = await page.locator(".splash").boundingBox();
    assert.ok(sb.y >= box.y + box.height - 1, "splash sits below the door strip");
    const nb = await page.locator(".splash-note").boundingBox();
    assert.ok(nb.y + nb.height <= 768 + 1, "the coach line does not spill off screen");
  } finally { await browser.close(); }
});

test("tapping the door on the building screen leaves for New ERA's home", async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await makePage(browser);
    await page.locator("#barDoor").click();
    await page.waitForURL(/\/home\/?$/, { timeout: 10000 });
  } finally { await browser.close(); }
});

// ---- the splash's bar must not outlive the splash (9/17) --------------------
// The waiting screen mounts a REAL bar — same two doors, same listeners — and
// the board that replaces it mounts a second one. The swap is two innerHTML=""
// calls (board.js, board-render.js) which take the strip out of the document
// and leave era-core's bar object alive behind it, still holding a
// `visibilitychange` listener on `document` and a `resize` listener on `window`
// that nothing in the document can reach. Harmless only until she uses the
// screen it belongs to: 💬 on the splash while her board is still building
// arms THAT bar's pause, and her return then wakes a strip that is not on the
// screen. destroy() is era-core's answer and this is the board's half of it.
const SONGS_SETTINGS = JSON.stringify({
  dwellMs: 900, settleMs: 0, musicVolCap: 100, exitTo: "tdsnap", pauseGoes: "tdsnap",
  doorGoes: "tdsnap", lockMinutes: 45, lockPasscodeHash: "", childName: "friend",
  hasProfile: true, personalWords: [],
});
const QUIET = JSON.stringify({ building: false, ingesting: null, photos: 3, cataloged: 3, aiConfigured: true });
const QUIET_CONTENT = JSON.stringify({ mode: "local", local: true, building: false, job: null, queued: [], jobs: [] });

test("the splash's bar goes with the splash — her return reaches the board's own", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true });
    let empty = true;    // the library is empty until the grown-up's first song lands
    await ctx.route("**/recipes/songs.json", (r) =>
      (empty ? r.fulfill({ status: 404, body: "not found" }) : r.fallback()));
    await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
    await ctx.route("**/music-event", (r) => r.fulfill({ status: 204, body: "" }));
    await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
    await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
    await ctx.route("**/settings", (r) => r.fulfill({ status: 200, contentType: "application/json", body: SONGS_SETTINGS }));
    await ctx.route("**/clothing/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: QUIET }));
    await ctx.route("**/content/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: QUIET_CONTENT }));
    await ctx.route("**/music/add/status", (r) => r.fulfill({ status: 200, contentType: "application/json",
      body: '{"pack":{"id":"media-tools","installed":true},"folder":true,"running":null,"last":null}' }));
    const pauses = [];
    await ctx.route("**/kiosk/pause", (r) => {
      pauses.push(1);
      r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"paused"}' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      try { localStorage.clear(); } catch {}
      window.__testHooks = true;
      window.__boardTest = { retryMs: 300, statusMs: 36e5, busyMs: 36e5, pollMs: 36e5, idleMs: 36e5, addPollMs: 120 };
    });
    await page.goto(BASE + "?recipe=songs", { waitUntil: "load" });
    await page.waitForSelector(".splash");
    assert.equal(await page.locator(".msgbar").count(), 1, "the waiting screen wears one bar");

    // she asks to talk WHILE the board is still empty: this bar's pause is armed
    await page.locator("#barTalk").click();
    await page.waitForFunction(() => true);
    assert.equal(pauses.length, 1, "the splash's 💬 reached the hub");

    // the first song lands and the retry swaps the splash for a real board
    empty = false;
    await page.waitForFunction(() => window.Board && typeof window.Board.show === "function",
                               null, { timeout: 15000 });
    assert.equal(await page.locator(".msgbar").count(), 1,
                 "one bar on the screen, not the splash's and the board's");

    // her own pause, on the board's bar, mid-song
    await page.locator(".tile.type-song").first().click();
    await page.waitForFunction(() => window.Music.playingId() === "test-song-1" &&
                                     window.Music._audio.currentTime > 0.1, null, { timeout: 8000 });
    await page.locator("#barTalk").click();
    await page.waitForFunction(() => window.Music._audio.paused, null, { timeout: 4000 });

    // TD Snap hands the screen back. Exactly ONE bar may answer — the settle
    // window is the bar's fingerprint, so a second call means the splash's bar
    // is still listening with the pause it took minutes ago still armed.
    const suppressed = await page.evaluate(() => {
      const D = window.Dwell;
      if (D && typeof D.suppress === "function" && !D.__spied) {
        const real = D.suppress.bind(D);
        D.suppress = (ms) => { window.__suppressLog.push(ms); return real(ms); };
        D.__spied = true;
      }
      window.__suppressLog = [];
      document.dispatchEvent(new Event("visibilitychange"));
      return window.__suppressLog;
    });
    assert.deepEqual(suppressed, [600], "only the board's own bar answered her return");
    await page.waitForFunction(() => !window.Music._audio.paused, null, { timeout: 4000 });
    assert.equal(await page.evaluate(() => window.Music.playingId()), "test-song-1",
                 "...and it is the board's onResume that ran: her song plays on");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});
