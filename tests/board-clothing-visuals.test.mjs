// board-clothing-visuals.test.mjs — the hub's Clothing Picker recipes must
// LOOK like Ellie's board (dad 8/29: "even the buttons and header sizes don't
// match — please match exactly"). Root cause of the mismatch: isPhoto() only
// knew her home image prefixes (wardrobe/), so the hub generator's tiles
// (wardrobe-items/, wardrobe-outfits/, clothing-web/) rendered as small icons
// instead of cell-filling photos. Recipe + images stubbed at the network
// layer (board-movies harness pattern); hermetic, no hub data needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = "http://localhost:8377/board/?recipe=today";

const JPG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64");

// The wardrobe items the hub names on the tiles that carry them (spec
// 2026-09-17 §4). A tile that NAMES clothes carries the objects, not bare ids,
// so nothing downstream has to parse "Heart tee + leggings" back into two
// garments.
const TEE = { id: "item_a", name: "Heart print tee", category: "top", occasion: "everyday" };
const LEGGINGS = { id: "item_b", name: "Pink leggings", category: "pants", occasion: "everyday" };

// EXACTLY the shapes the hub's clothing.js emits: cataloged mode (composite
// outfit + confirm graph + item tiles) and plain pre-catalog mode.
const FIXTURE = {
  locale: "en-US", root: "today", home_label: "Clothing",
  categories: [{ id: "top", label: "Top" }, { id: "pants", label: "Pants" },
               { id: "jacket", label: "Jacket" }],
  boards: [
    { id: "today", name: "What will I wear today?", rows: 3, columns: 4,
      buttons: [
        { label: "82°  hot", type: "control", symbol: "sun",
          say: "Today it is hot.", footnote: "Sample forecast", row: 2, col: 2, col_span: 2 },
        { label: "Heart tee + leggings", say: "Heart tee and pink leggings",
          type: "outfit", image: "wardrobe-outfits/outfit_0.jpg",
          load: "confirm_0", say_on_load: true, combo: ["item_a", "item_b"],
          items: [TEE, LEGGINGS] },
        { label: "This one", say: "I want to wear this one", type: "outfit",
          image: "clothing-web/IMG_1.jpg" },
        { label: "Full wardrobe", type: "category", image: "board/wardrobe.svg",
          load: "build", row: 3, col: 4 },
      ] },
    { id: "confirm_0", name: "This one?", rows: 3, columns: 2,
      buttons: [
        { label: "Heart tee + leggings", say: "Heart tee and pink leggings",
          type: "outfit", image: "wardrobe-outfits/outfit_0.jpg", combo: ["item_a", "item_b"] },
        { label: "Yes", type: "yes", symbol: "yes", say: "Yes", combo: ["item_a", "item_b"] },
        { label: "Change top", type: "category", symbol: "shirt", load: "cat_top" },
        { label: "Change bottoms", type: "category", symbol: "trousers", load: "choose_bottom" },
        { label: "Back", type: "back", glyph: "←", load: "today" },
      ] },
    { id: "cat_top", name: "Tops", rows: 3, columns: 4,
      buttons: [
        { label: "Back", type: "back", glyph: "←", load: "today", row: 1, col: 1 },
        { label: "Heart print tee", say: "Heart print tee", type: "clothing",
          image: "wardrobe-items/item_a.jpg", row: 1, col: 2, items: [TEE] },
      ] },
    { id: "choose_bottom", name: "Pants or shorts?", rows: 2, columns: 2,
      buttons: [
        { label: "Pants", type: "category", symbol: "trousers", load: "cat_top" },
        { label: "Back", type: "back", glyph: "←", load: "today" },
      ] },
    { id: "build", name: "Full wardrobe", rows: 3, columns: 2,
      buttons: [
        { label: "Tops", type: "category", symbol: "shirt", load: "cat_top" },
        { label: "Back", type: "back", glyph: "←", load: "today" },
      ] },
  ],
};

async function makePage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, hasTouch: true });
  const outfitEvents = [];
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/symbol/*", (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: JPG }));
  await ctx.route(/\/(wardrobe-outfits|wardrobe-items|clothing-web)\/.*\.jpg$/, (r) =>
    r.fulfill({ status: 200, contentType: "image/jpeg", body: JPG }));
  await ctx.route("**/recipes/today.json", (r) => {
    const headers = { "Content-Type": "application/json", "ETag": '"clothing-fixture-1"', "Cache-Control": "no-cache" };
    if (r.request().method() === "HEAD") { r.fulfill({ status: 200, headers, body: "" }); return; }
    r.fulfill({ status: 200, headers, body: JSON.stringify(FIXTURE) });
  });
  await ctx.route("**/outfit-event", (r) => {
    outfitEvents.push(r.request().postDataJSON());
    r.fulfill({ status: 204, body: "" });
  });
  await ctx.addInitScript(() => { window.__testHooks = true; });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  return { ctx, page, outfitEvents };
}

test("clothing tiles fill their cells like Ellie's board", async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await makePage(browser);

    // composite outfit tile and raw pre-catalog photo both ride the photo path
    const outfit = page.locator('.tile.type-outfit', { hasText: "Heart tee" });
    assert.ok(await outfit.evaluate((el) => el.classList.contains("photo")),
      "wardrobe-outfits/ composite fills the cell");
    const plain = page.locator('.tile.type-outfit', { hasText: "This one" });
    assert.ok(await plain.evaluate((el) => el.classList.contains("photo")),
      "clothing-web/ raw photo fills the cell");

    // her graph walks: outfit -> confirm page with Yes / Change top / Change bottoms
    await outfit.click();
    await page.waitForFunction(() => window.Board.session.currentId === "confirm_0", null, { timeout: 8000 });
    for (const label of ["Yes", "Change top", "Change bottoms", "Back"])
      assert.equal(await page.locator(".tile", { hasText: label }).count(), 1, label + " on confirm");

    // item tile on a category board is a photo too, with its AI-given name
    await page.locator(".tile", { hasText: "Change top" }).click();
    await page.waitForFunction(() => window.Board.session.currentId === "cat_top", null, { timeout: 8000 });
    const item = page.locator(".tile.type-clothing");
    assert.equal(await item.count(), 1, "item tile present");
    assert.ok(await item.evaluate((el) => el.classList.contains("photo")),
      "wardrobe-items/ tile fills the cell");
  } finally { await browser.close(); }
});

// ---------------------------------------------------------- T7 (spec §4, 9/17)
// The hold-to-edit sheet has to know WHICH wardrobe items are under a finger
// before anything about the sheet exists — and it must never learn that by
// reading the label ("Heart tee + leggings" is one string and two garments).
// So the render stamps the ids on the tile for a selector to find, and keeps
// the item OBJECTS in a WeakMap the sheet asks for by element. A tile that
// names no clothes (More, Full wardrobe, the weather plate, a raw pre-catalog
// photo) carries neither — `[data-items]` is the whole arming filter.
test("tiles that name wardrobe items carry their ids, and the objects behind them", async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await makePage(browser);

    const outfit = page.locator('.tile.type-outfit', { hasText: "Heart tee" });
    assert.equal(await outfit.getAttribute("data-items"), "item_a,item_b",
      "the outfit tile stamps BOTH ids, in combo order");
    const plain = page.locator('.tile.type-outfit', { hasText: "This one" });
    assert.equal(await plain.getAttribute("data-items"), null,
      "a pre-catalog photo names no catalogued item: no attribute at all");
    assert.equal(await page.locator('.tile', { hasText: "Full wardrobe" }).getAttribute("data-items"), null,
      "…and neither does a door");

    // The objects. Same module instance the page rendered with (an ES module is
    // cached per URL), so this is the renderer's real WeakMap, not a second one.
    const got = await page.evaluate(async () => {
      const m = await import("./board-render.js");
      const pick = (sel, text) => [...document.querySelectorAll(sel)]
        .find((el) => (el.textContent || "").includes(text));
      const o = pick(".tile.type-outfit", "Heart tee");
      const d = pick(".tile", "Full wardrobe");
      return {
        has: typeof m.tileButton === "function",
        outfit: (m.tileButton(o) || {}).items || null,
        door: (m.tileButton(d) || {}).items || null,
      };
    });
    assert.equal(got.has, true, "board-render exports tileButton(el)");
    assert.deepEqual(got.outfit, [
      { id: "item_a", name: "Heart print tee", category: "top", occasion: "everyday" },
      { id: "item_b", name: "Pink leggings", category: "pants", occasion: "everyday" },
    ], "the recipe's own objects come back, whole");
    assert.equal(got.door, null, "a door has no entry");

    // and a garment tile on a browse grid carries exactly one
    await page.evaluate(() => window.Board.show("cat_top"));
    const item2 = page.locator(".tile.type-clothing");
    assert.equal(await item2.getAttribute("data-items"), "item_a", "one garment, one id");
    assert.equal(await page.evaluate(async () => {
      const m = await import("./board-render.js");
      return m.tileButton(document.querySelector(".tile.type-clothing")).items.length;
    }), 1, "…and one object");
  } finally { await browser.close(); }
});


test("weather spans the centre quietly and speaks repeatedly without choosing clothes", async () => {
  const browser = await chromium.launch();
  try {
    const { page, outfitEvents } = await makePage(browser);
    const weather = page.locator('.tile[aria-label="82°  hot"]');
    const style = await weather.evaluate(el => ({
      bg: getComputedStyle(el).backgroundColor,
      ink: getComputedStyle(el).color,
      column: el.style.gridColumn,
      row: el.style.gridRow,
      say: el.dataset.dwellSay,
    }));
    assert.equal(style.bg, "rgb(206, 219, 214)");
    assert.equal(style.ink, "rgb(23, 39, 46)");
    assert.equal(style.column, "2 / span 2");
    assert.equal(style.row, "2");
    assert.equal(style.say, "Today it is hot.");
    await page.evaluate(() => { window.__speechLog.length = 0; });
    await page.waitForFunction(() => window.Dwell && window.Dwell.state().suppressedMs === 0);
    const box = await weather.boundingBox();
    const hold = Number(await weather.getAttribute("data-dwell-ms"));
    for (let i = 0; i < 2; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(hold + 500);
      assert.equal(await page.locator('.tile[aria-label="82°  hot"]').count(), 1);
      await page.mouse.move(5, 5);
      await page.waitForTimeout(500);
    }
    assert.deepEqual(await page.evaluate(() => window.__speechLog
      .filter(e => e.call === "say").map(e => e.text)), ["Today it is hot.", "Today it is hot."]);
    assert.equal(outfitEvents.length, 0);
    const door = page.locator('.tile[aria-label="Full wardrobe"]');
    assert.ok(await door.locator('img').evaluate(el => el.complete && el.naturalWidth > 0));
    await door.click();
    assert.equal(await page.locator('.tile[aria-label="Tops"]').count(), 1);
  } finally { await browser.close(); }
});
