// board-content-note.test.mjs — a book being built says so ON THE BOARD, in
// the same partner strip the wardrobe note uses (T2.11): the family drops page
// photos in Drive and then stares at a board that looks unchanged for ten
// minutes. The note follows /content/status, and when a finished book carries
// words the AI was unsure of it becomes the one tap to the review page.
// Touch only, never a gaze target, and NOT in the message bar — the bar carries
// the door and nothing else (design rule; gates: board-input + board-pixel).
// Hermetic: every hub route the board touches is stubbed, so no port of its own
// (the page itself is served by the gate's hub, port re-pointed by era-gate.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/";
const QUIET_CLOTHING = { building: false, ingesting: null, photos: 3, cataloged: 3, aiConfigured: true };

// One book's /content/status entry, in the shape content.js:jobFor() writes.
function book(over) {
  return Object.assign({
    kind: "books", slug: "tabby-mctat", title: "Tabby McTat",
    state: "transcribing", step: "transcribe",
    progress: { pages: 12, transcribed: 4, narrated: 0 },
    cost: { characters: 0, narrated: 0 }, flags: 0,
    pausedUntil: null, note: null, published: false, error: null,
  }, over || {});
}
const statusFor = (jobs, running) => ({
  mode: "local", local: true, skipped: null,
  building: !!running, job: running || null,
  queued: [], jobs, lastScan: null,
});

// A context with every hub route the board polls stubbed; `state` is the live
// dial the test turns.
async function open(browser, state, opts) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/clothing/status", (r) => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(state.clothing || QUIET_CLOTHING) }));
  await ctx.route("**/content/status", (r) => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(state.content) }));
  if (opts && opts.noRecipe)
    await ctx.route("**/recipes/today.json", (r) => r.fulfill({ status: 404, body: "not found" }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch {}
    window.__boardTest = { statusMs: 150, busyMs: 150, pollMs: 60 * 60 * 1000, idleMs: 60 * 60 * 1000, retryMs: 300 };
  });
  await page.goto(BASE, { waitUntil: "load" });
  return { ctx, page, errors };
}

const noteSays = (page, re) => page.waitForFunction(
  (src) => new RegExp(src).test(document.getElementById("contentNote").textContent),
  re.source, { timeout: 6000 });

test("the book note follows the build and ends as the tap to the review page", async () => {
  const browser = await chromium.launch();
  try {
    const state = { content: statusFor([]) };
    const { ctx, page, errors } = await open(browser, state);
    await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
    await page.waitForTimeout(500);

    const note = page.locator("#contentNote");
    assert.equal(await note.isVisible(), false, "no books building: no footer");
    assert.equal(await page.locator(".msgbar > *").count(), 1, "the bar carries the door and nothing else");
    assert.equal(await page.evaluate(() => document.getElementById("contentNote").classList.contains("dwell")),
      false, "the book note is never a gaze target");

    // reading the words off the photos
    state.content = statusFor([book()], { kind: "books", slug: "tabby-mctat", step: "transcribe" });
    await noteSays(page, /Tabby McTat/);
    await noteSays(page, /page 5 of 12/);

    // recording the narration
    state.content = statusFor(
      [book({ state: "reviewing", step: "narrate", progress: { pages: 12, transcribed: 12, narrated: 3 } })],
      { kind: "books", slug: "tabby-mctat", step: "narrate" });
    await noteSays(page, /page 4 of 12/);

    // finished, with words the AI was unsure of: the note becomes the one tap
    // to the review page (spec §5), and is still touch-only.
    state.content = statusFor([book({
      state: "done", step: null, published: true, flags: 3,
      progress: { pages: 12, transcribed: 12, narrated: 12 } })]);
    await noteSays(page, /ready to read/i);
    const href = await page.evaluate(() => {
      const a = document.querySelector("#contentNote a");
      return a ? a.getAttribute("href") : null;
    });
    assert.equal(href, "/book-review/?slug=tabby-mctat", "flagged book links to its review page");
    assert.equal(await page.evaluate(() => document.querySelectorAll("#contentNote .dwell").length), 0,
      "the review link is touch-only");
    assert.equal(await page.locator(".msgbar > *").count(), 1, "still nothing added to the bar");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

test("a book being built also speaks on the nothing-to-show splash", async () => {
  const browser = await chromium.launch();
  try {
    const state = {
      // the clothing coach's default case (no photos, no key) — the one state
      // where the splash has nothing of its own to say, so the book gets the line
      clothing: { building: false, ingesting: null, photos: 0, cataloged: 0, aiConfigured: false },
      content: statusFor([book()], { kind: "books", slug: "tabby-mctat", step: "transcribe" }),
    };
    const { ctx, page, errors } = await open(browser, state, { noRecipe: true });
    await page.waitForSelector(".splash");
    await page.waitForFunction(() => /Tabby McTat/.test(document.body.textContent), null, { timeout: 8000 });
    const txt = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".splash, .splash-note")).map(e => e.textContent).join(" | "));
    assert.match(txt, /book/i, "the splash says a book is being made");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});
