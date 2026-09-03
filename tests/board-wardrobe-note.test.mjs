// Wardrobe footer + partner "new outfits" button on the clothing board (dad
// 9/3: "I added photos after my first run - a footer that says new photos were
// found and are processing; if not automatically triggered I can re-run
// today's outfits with the new ones").
// Part 1: the client, against the LIVE gate server's board with /clothing/*
// and the recipe HEAD faked per state (hermetic: nothing is rebuilt).
// Part 2: POST /clothing/regenerate on the REAL server.js on a test port with
// a scratch data dir - 202 at once, the build runs on behind it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.resolve(__dirname, "..");
const BASE = "http://localhost:8377/board/";
const PORT = 8407; // never live 8377; 8390-8424 minus this one are held by sibling suites (8394 = pool)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("footer follows the wardrobe work; the button asks the hub for new outfits", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
    await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" }));
    await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
    await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
    // the hub's wardrobe state, driven by the test
    let status = { building: false, ingesting: { done: 0, total: 0 }, photos: 3, cataloged: 3, aiConfigured: true };
    let etag = null;   // null = let the real HEAD through (unchanged board)
    const posts = [];
    await ctx.route("**/clothing/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) }));
    await ctx.route("**/clothing/regenerate", (r) => { posts.push(r.request().method()); r.fulfill({ status: 202, contentType: "application/json", body: '{"started":true}' }); });
    await ctx.route("**/recipes/today.json", (r) => {
      if (r.request().method() === "HEAD" && etag) return r.fulfill({ status: 200, headers: { etag } , body: "" });
      r.continue();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => { window.__boardTest = { statusMs: 200, busyMs: 200, pollMs: 60 * 60 * 1000, idleMs: 60 * 60 * 1000, retryMs: 60 * 60 * 1000 }; });
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
    await sleep(600);

    const note = page.locator("#wardrobeNote");
    const btn = page.locator("#barRefresh");
    assert.equal(await note.isVisible(), false, "quiet wardrobe: no footer");
    assert.equal(await btn.count(), 1, "partner button on the bar");
    assert.equal(await page.evaluate(() => document.getElementById("barRefresh").classList.contains("dwell")), false, "button is touch-only, never a gaze target");
    assert.ok(await page.evaluate(() => document.querySelector(".msgbar").contains(document.getElementById("barRefresh"))), "button lives in the door bar");
    const bb = await btn.boundingBox(); const db = await page.locator("#barDoor").boundingBox();
    assert.ok(bb.x > db.x + db.width + 200, "button sits at the far end of the bar, away from the door");

    await btn.click(); await sleep(300);
    assert.deepEqual(posts, ["POST"], "one POST /clothing/regenerate");
    assert.equal(await note.isVisible(), true);
    assert.match(await note.textContent(), /Looking for new clothing photos/);
    assert.equal(await btn.isDisabled(), true, "button rests while the hub works");

    const noteSays = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("wardrobeNote").textContent), re.source, { timeout: 4000 });
    status = { ...status, ingesting: { done: 1, total: 3 } };
    await noteSays(/New clothing photos found .* photo 2 of 3/);
    status = { ...status, ingesting: { done: 0, total: 0 }, building: true };
    await noteSays(/Putting today.s outfits together/);

    // the build lands a new recipe: footer turns into the "see them" tap
    etag = '"new-board"';
    status = { ...status, building: false };
    await noteSays(/New outfits are ready/);
    assert.ok(await page.evaluate(() => document.getElementById("wardrobeNote").classList.contains("ready")));
    assert.equal(await btn.isDisabled(), false);
    await Promise.all([page.waitForEvent("load"), note.click()]);   // tap = reload now
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();
  } finally { await browser.close(); }
});

// ---- part 2: the route on the real server ----------------------------------
let child, DATA;
function waitFor(url, tries = 100) {
  return new Promise((resolve, reject) => {
    const t = async () => {
      try { await fetch(url); return resolve(); } catch {}
      if (--tries <= 0) return reject(new Error("server never came up"));
      setTimeout(t, 100);
    };
    t();
  });
}
before(async () => {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), "wardrobe-note-"));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: STUDIO, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1" },
  });
  await waitFor(`http://127.0.0.1:${PORT}/settings`);
});
after(() => { if (child) child.kill("SIGKILL"); });

test("POST /clothing/regenerate answers 202 at once and the hub keeps serving", async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/clothing/regenerate`, { method: "POST" });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { started: true });
  await sleep(300);
  const s = await (await fetch(`http://127.0.0.1:${PORT}/clothing/status`)).json();
  assert.equal(typeof s.building, "boolean");
  assert.equal(s.photos, 0, "scratch data dir: no photos, nothing to add");
  const g = await fetch(`http://127.0.0.1:${PORT}/clothing/regenerate`);   // GET is not the button
  assert.notEqual(g.status, 202);
});
