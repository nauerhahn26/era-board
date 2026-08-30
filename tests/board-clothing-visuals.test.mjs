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

// EXACTLY the shapes the hub's clothing.js emits: cataloged mode (composite
// outfit + confirm graph + item tiles) and plain pre-catalog mode.
const FIXTURE = {
  locale: "en-US", root: "today", home_label: "Clothing",
  boards: [
    { id: "today", name: "What will I wear today?", rows: 3, columns: 4,
      buttons: [
        { label: "82°  hot", type: "control", symbol: "sun",
          say: "Today it is hot.", row: 1, col: 1 },
        { label: "Heart tee + leggings", say: "Heart tee and pink leggings",
          type: "outfit", image: "wardrobe-outfits/outfit_0.jpg",
          load: "confirm_0", say_on_load: true, combo: ["item_a", "item_b"] },
        { label: "This one", say: "I want to wear this one", type: "outfit",
          image: "clothing-web/IMG_1.jpg" },
        { label: "Build my own", type: "category", symbol: "clothes",
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
          image: "wardrobe-items/item_a.jpg", row: 1, col: 2 },
      ] },
    { id: "choose_bottom", name: "Pants or shorts?", rows: 2, columns: 2,
      buttons: [
        { label: "Pants", type: "category", symbol: "trousers", load: "cat_top" },
        { label: "Back", type: "back", glyph: "←", load: "today" },
      ] },
    { id: "build", name: "Build my own", rows: 3, columns: 2,
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
