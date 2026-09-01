// board-clothing-coach.test.mjs — the clothing board's no-content splash is a
// live coach (dad 8/31): after photo upload a novice saw nothing (or raw
// "This one" dumps); now the splash names what worked and the ONE next step,
// driven by the hub's /clothing/status. Network-stubbed, hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/";

async function makePage(browser, statusBody) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const state = { status: statusBody };
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/recipes/today.json", (r) => r.fulfill({ status: 404, body: "not found" }));
  await ctx.route("**/clothing/status", (r) => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(state.status) }));
  const page = await ctx.newPage();
  // localStorage from other suites' runs would paint a cached board instead
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".splash");
  return { ctx, page, state };
}

const splashText = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll(".splash")).map(e => e.textContent).join(" | "));

test("photos + no key: celebrates the upload and deep-links the AI step", async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await makePage(browser, {
      building: false, ingesting: null, cataloged: 0, photos: 20, aiConfigured: false });
    // no count: Drive materialises files gradually so any number is stale (9/1)
    await page.waitForFunction(() => document.body.textContent.includes("your clothing photos"), null, { timeout: 8000 });
    const txt = await splashText(page);
    assert.match(txt, /great work/i);
    assert.match(txt, /AI helper key/i);
    assert.equal(await page.locator('a[href="/settings/#ai"]').count(), 1, "deep-links Settings > AI");
  } finally { await browser.close(); }
});

test("key + no photos: points at the Drive clothing folder", async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await makePage(browser, {
      building: false, ingesting: null, cataloged: 0, photos: 0, aiConfigured: true });
    await page.waitForFunction(() => document.body.textContent.includes("AI helper is ready"), null, { timeout: 8000 });
    assert.equal(await page.locator('a[href="/settings/#integrations"]').count(), 1);
  } finally { await browser.close(); }
});

test("provider throttled: says so plainly, promises the retry (9/1 Google 503s)", async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await makePage(browser, {
      building: false, ingesting: null, cataloged: 0, photos: 8,
      aiConfigured: true, guidance: "ai-busy" });
    await page.waitForFunction(() => document.body.textContent.includes("busy right now"), null, { timeout: 8000 });
    const txt = await splashText(page);
    assert.match(txt, /photos are safe/i);
    assert.match(txt, /keeps trying/i);
    assert.equal(await page.locator('a[href]').count(), 0, "no dead-end link while it retries");
  } finally { await browser.close(); }
});

test("mid-ingest: live progress, and the board mounts by itself when the recipe lands", async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page, state } = await makePage(browser, {
      building: true, ingesting: { done: 2, total: 20 }, cataloged: 2, photos: 20, aiConfigured: true });
    await page.waitForFunction(() => document.body.textContent.includes("Naming photo 3 of 20"), null, { timeout: 8000 });

    // ingest finishes: recipe appears; the splash's retry loop must swap to the real board
    state.status = { building: false, ingesting: null, cataloged: 20, photos: 20, aiConfigured: true };
    await ctx.route("**/recipes/today.json", (r) => r.fulfill({
      status: 200, contentType: "application/json",
      headers: { ETag: '"coach-1"' },
      body: JSON.stringify({ locale: "en-US", root: "today", home_label: "Clothing", boards: [
        { id: "today", name: "What will I wear today?", rows: 3, columns: 4, buttons: [
          { label: "82°  hot", type: "control", symbol: "sun", row: 1, col: 1 } ] } ] }) }));
    await page.waitForSelector(".tile", { timeout: 30000 });
    assert.ok((await page.locator(".tile").count()) >= 1, "board mounted on its own");
  } finally { await browser.close(); }
});
