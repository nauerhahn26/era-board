// board-splash-door.test.mjs — the waiting screen keeps the door. Dad 9/3:
// "While the clothing picker is building it should still have the door exit,
// otherwise no way to return back to New ERA." The splash used to carry zero
// dwell targets for the minutes a 40-photo ingest takes; now it wears the same
// door strip the board does, and the door's fallback (no engine) lands on
// /home/. Network-stubbed like the coach suite; drives the live server.
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
  await ctx.route("**/kiosk/close", (r) => r.fulfill({ status: 204, body: "" }));
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
    assert.ok(Number(await door.getAttribute("data-dwell-ms")) >= 1600, "exit hold is the deliberate long one");
    assert.equal(await page.locator(".dwell").count(), 1, "the door is the splash's one dwell target");
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
