// T3.2/T3.3 — freshness + resilience tests for /board/ (Phase 3).
// Drives the LIVE server at :8377 with playwright routing to simulate the
// server being unreachable (route.abort) and recipe changes (HEAD etag swap).
// Timing is compressed via window.__boardTest (armed BEFORE page scripts run).
//
// Covered behaviors (plan T3.2/T3.3-B):
//   1. offline boot + last-good cache  -> cached board renders, netWarn shows
//   2. server returns w/ newer recipe  -> auto reload once idle, netWarn hides
//   3. recipe regenerated while online -> reload only when idle
//   4. recipe changed but she's ACTIVE -> no reload (no mid-use yank)
//   5. first boot, no cache, offline   -> splash, then recovers in-place
//
// Runs under `node --test` or `node tests/board-resilience.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/";
const RECIPE = "**/recipes/today.json";

const CACHED = {
  root: "cached",
  boards: [{
    id: "cached", columns: 2,
    buttons: [
      { label: "Cached outfit", type: "outfit" },
      { label: "Yes", type: "yes" },
    ],
  }],
};

// Hermetic page: audio dead-ended, timers compressed, boot counter in
// sessionStorage (init script re-runs on reload, so it survives navigations).
async function makePage(browser, { timing, primeCache, hidden } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" })); // hermetic: never write her real pick history
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.addInitScript(({ timing, primeCache, hidden }) => {
    window.__testHooks = true;
    window.__boardTest = timing;
    sessionStorage.bootCount = String((+sessionStorage.bootCount || 0) + 1);
    // A minimized kiosk (she is in TD Snap saying something, 9/17) — the one
    // state a driven browser cannot enter by itself. Re-applied on every
    // navigation, which is what makes "she is still away" survive a reload.
    if (hidden) Object.defineProperty(document, "visibilityState",
                                      { configurable: true, get: () => "hidden" });
    if (primeCache) {
      localStorage.setItem("board:lastRecipe", JSON.stringify(primeCache.recipe));
      localStorage.setItem("board:lastRecipeEtag", primeCache.etag);
    }
  }, { timing, primeCache, hidden });
  const page = await ctx.newPage();
  return { ctx, page };
}

const bootCount = (page) => page.evaluate(() => +sessionStorage.bootCount);
const netWarnShown = (page) =>
  page.evaluate(() => document.getElementById("netWarn").classList.contains("show"));
const ready = (page) =>
  page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });

test("offline boot renders the last-good cached recipe + offline banner", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, {
      timing: { pollMs: 60000, retryMs: 60000, idleMs: 60000 },
      primeCache: { recipe: CACHED, etag: 'W/"stale"' },
    });
    await ctx.route(RECIPE, (r) => r.abort()); // server "down"
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    assert.equal(await page.locator(".tile", { hasText: "Cached outfit" }).count(), 1);
    assert.equal(await netWarnShown(page), true, "netWarn banner must show while offline");
    assert.equal(await bootCount(page), 1);
    await ctx.close();
  } finally { await browser.close(); }
});

test("server back with a newer recipe -> reloads once idle, banner clears", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, {
      timing: { pollMs: 250, retryMs: 250, idleMs: 50 },
      primeCache: { recipe: CACHED, etag: 'W/"stale"' }, // live etag WILL differ
    });
    await ctx.route(RECIPE, (r) => r.abort());
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    assert.equal(await netWarnShown(page), true);

    const nav = page.waitForEvent("framenavigated", { timeout: 10000 });
    await ctx.unroute(RECIPE); // server "back"
    await nav;                 // auto-reload fired
    await ready(page);
    assert.equal(await bootCount(page), 2, "one automatic reload");
    assert.equal(await netWarnShown(page), false, "banner clears once live");
    assert.equal(await page.locator(".tile", { hasText: "Cached outfit" }).count(), 0, "live recipe replaces cached one");
    await ctx.close();
  } finally { await browser.close(); }
});

test("recipe regenerated while online -> reload when idle", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, {
      timing: { pollMs: 250, retryMs: 250, idleMs: 50 },
    });
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);

    const nav = page.waitForEvent("framenavigated", { timeout: 10000 });
    // regeneration = HEAD etag changes (GET untouched so the reload still works)
    await ctx.route(RECIPE, (r) =>
      r.request().method() === "HEAD"
        ? r.fulfill({ status: 200, headers: { etag: 'W/"regenerated"' }, body: "" })
        : r.fallback());
    await nav;
    await ready(page);
    assert.equal(await bootCount(page), 2);
    await ctx.close();
  } finally { await browser.close(); }
});

test("recipe changed but she is mid-use -> NO reload", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, {
      timing: { pollMs: 150, retryMs: 150, idleMs: 60000 }, // idle bar unreachable
    });
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    await ctx.route(RECIPE, (r) =>
      r.request().method() === "HEAD"
        ? r.fulfill({ status: 200, headers: { etag: 'W/"regenerated"' }, body: "" })
        : r.fallback());
    // she keeps looking around for ~1.2s (≥7 poll ticks see the new etag)
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(400 + i * 40, 400 + (i % 3) * 30);
      await page.waitForTimeout(100);
    }
    assert.equal(await bootCount(page), 1, "board must never yank mid-use");
    await ctx.close();
  } finally { await browser.close(); }
});

test("she is away talking (hidden) -> NO reload; it waits for her to be back", async () => {
  const browser = await chromium.launch();
  try {
    // 💬 PAUSE TO TALK (dad 9/17): the kiosk is minimized under TD Snap with her
    // song paused mid-verse. "Idle" is now true BY DEFINITION — a minimized page
    // gets no pointermove — so the one guard that has always protected her from
    // a mid-use yank is inert exactly when she is most exposed: a Drive sync, a
    // clothing rebuild or a new song lands a fresh etag, the board reloads
    // itself, and /kiosk/resume hands her back a blank board with no song. A
    // page nobody is looking at must never reload itself.
    const { ctx, page } = await makePage(browser, {
      timing: { pollMs: 150, retryMs: 150, idleMs: 50 }, // idle the instant she leaves
      hidden: true,
    });
    await page.goto(BASE, { waitUntil: "load" });
    await ready(page);
    await ctx.route(RECIPE, (r) =>
      r.request().method() === "HEAD"
        ? r.fulfill({ status: 200, headers: { etag: 'W/"regenerated"' }, body: "" })
        : r.fallback());
    await page.waitForTimeout(1200);   // ≥7 poll ticks see the new etag
    assert.equal(await bootCount(page), 1, "a page she cannot see must not reload under her");

    // TD Snap hands the screen back: she is looking at it again, and still
    // idle — so the reload it has been holding happens on the very next tick.
    const nav = page.waitForEvent("framenavigated", { timeout: 10000 });
    await page.evaluate(() => Object.defineProperty(document, "visibilityState",
                                                    { configurable: true, get: () => "visible" }));
    await nav;
    await ready(page);
    assert.equal(await bootCount(page), 2, "once she is back and idle, the newer recipe lands");
    await ctx.close();
  } finally { await browser.close(); }
});

test("first boot, no cache, offline -> splash, then recovers in place", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await makePage(browser, {
      timing: { pollMs: 250, retryMs: 250, idleMs: 60000 },
    });
    await ctx.route(RECIPE, (r) => r.abort());
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector(".splash", { timeout: 8000 });
    await ctx.unroute(RECIPE);
    await ready(page); // board appears without any manual action
    assert.equal(await bootCount(page), 1, "recovery happens in-document, no reload");
    assert.equal(await page.locator(".splash").count(), 0, "splash cleared");
    assert.equal(await netWarnShown(page), false);
    await ctx.close();
  } finally { await browser.close(); }
});
