// board-label-fit.test.mjs — WORD INTEGRITY for one long word (board-render.js
// header): a label never breaks mid-word, never hyphenates, never clips. A
// single word wider than its tile must make the font step down until the whole
// word sits inside the tile — never a label wider than the tile it lives in.
// Seen on a 3x4 board at 1280x800: a glyph word tile "Harmonicas!" painted at
// 82px in a 583px span inside a ~290px tile, so only "rmonic" showed. The
// span grew with its text, so the fitter's overflow test measured the label
// against itself.
// A word that cannot be whole even at the absolute minimum (fontMin) in the
// tile is fit-impossible: the renderer must then sit at fontMin, marked
// data-font-reduced, with the overflow VISIBLE to the label's own box (so the
// pixel gate's scrollWidth check reports it) — never a silent full-size pass.
// Which words are fit-impossible depends on the browser's font (the board asks
// for Segoe UI; a Linux test browser falls back to a much wider bold face), so
// the suite measures that per word instead of assuming it.
// The recipe is STUBBED at the network layer; this suite tests the board.
// Runs under `node --test` or `node tests/board-label-fit.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const CONTRACT = await (async () => {
  for (const p of ["../public/lib/contract.js", "../../era-core/lib/contract.js"]) {
    try { return (await import(new URL(p, import.meta.url))).CONTRACT; } catch { /* next */ }
  }
  throw new Error("lib/contract.js not found from " + import.meta.url);
})();
const S = CONTRACT.sizes;

const BASE = "http://localhost:8377/board/?recipe=label-fit";

const LONG = ["Harmonicas!", "Extraordinary!", "Trumpets!"];
const FIXTURE = {
  locale: "en-US", root: "label-fit",
  boards: [
    { id: "label-fit", name: "Words", rows: 3, columns: 4, buttons: [
      // glyph word tiles: the shape that clipped
      { type: "word", label: LONG[0], say: "harmonicas", glyph: "🎵", row: 1, col: 1 },
      { type: "word", label: LONG[1], say: "extraordinary", glyph: "✨", row: 1, col: 2 },
      // a multi-word glyph label wraps at the space (control: must still pass)
      { type: "word", label: "Big drum", say: "big drum", glyph: "🥁", row: 1, col: 3 },
      // a text-only word tile (stacked icon path, control)
      { type: "word", label: LONG[1], say: "extraordinary", row: 2, col: 1 },
      { type: "word", label: LONG[2], say: "trumpets", glyph: "🎺", row: 2, col: 4 },
      { type: "word", label: "go", say: "go", glyph: "🚀", row: 3, col: 4 },
    ] },
  ],
};

async function render(browser, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/recipes/label-fit.json", (r) => {
    const headers = { "Content-Type": "application/json", "ETag": '"label-fit-1"', "Cache-Control": "no-cache" };
    if (r.request().method() === "HEAD") { r.fulfill({ status: 200, headers, body: "" }); return; }
    r.fulfill({ status: 200, headers, body: JSON.stringify(FIXTURE) });
  });
  await ctx.addInitScript(() => {
    try { localStorage.clear(); } catch {}
    window.__testHooks = true;
    window.__boardTest = { statusMs: 3600000, busyMs: 3600000, pollMs: 3600000,
                           idleMs: 3600000, retryMs: 300, reload: () => {} };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll(".board-area .tile-label").length >= 6, null, { timeout: 8000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  return { ctx, page, errors };
}

// Every label against its TILE's inner box (inside the border and padding),
// and the painted text of every word against the same box.
function measure(fontMin) {
  const out = [];
  for (const el of document.querySelectorAll(".board-area .tile-label")) {
    const tile = el.closest(".tile");
    const tr = tile.getBoundingClientRect(), tcs = getComputedStyle(tile);
    const inner = {
      l: tr.left + parseFloat(tcs.borderLeftWidth) + parseFloat(tcs.paddingLeft),
      r: tr.right - parseFloat(tcs.borderRightWidth) - parseFloat(tcs.paddingRight),
    };
    const lr = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const words = [...range.getClientRects()].map((r) => ({ l: r.left, r: r.right }));
    // the widest single word at fontMin, in the label's own face
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;left:-9999px;top:0;white-space:nowrap;max-width:none;font-size:" + fontMin + "px";
    probe.className = "tile-label";
    tile.appendChild(probe);
    let widest = 0;
    for (const w of el.textContent.split(/\s+/)) { probe.textContent = w; widest = Math.max(widest, probe.getBoundingClientRect().width); }
    probe.remove();
    out.push({
      text: el.textContent, fs: parseFloat(getComputedStyle(el).fontSize),
      possible: widest <= inner.r - inner.l + 1, widest,
      reduced: el.dataset.fontReduced === "1",
      inner, label: { l: lr.left, r: lr.right, w: lr.width },
      sw: el.scrollWidth, cw: el.clientWidth, words,
    });
  }
  return out;
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
  test(`label fit: a long single word stays whole inside its tile at ${viewport.width}x${viewport.height}`, async () => {
    const browser = await chromium.launch();
    try {
      const { ctx, page, errors } = await render(browser, viewport);
      const labels = await page.evaluate(measure, S.fontMin);
      assert.equal(labels.length, 6, "six labelled tiles");
      for (const m of labels) {
        const tag = `${viewport.width}x${viewport.height} "${m.text}" @${m.fs}px`;
        // the label box is held to the tile, whatever the word
        assert.ok(m.label.l >= m.inner.l - 1 && m.label.r <= m.inner.r + 1,
          `${tag}: label box ${m.label.l.toFixed(0)}..${m.label.r.toFixed(0)} (w ${m.label.w.toFixed(0)}) inside tile ${m.inner.l.toFixed(0)}..${m.inner.r.toFixed(0)}`);
        assert.ok(m.fs >= S.fontMin - 0.5, `${tag}: never under the absolute minimum`);
        if (m.fs < S.fontFloor - 0.5) assert.ok(m.reduced, `${tag}: under the floor only as a marked reduction`);
        if (!m.possible) {
          // fit-impossible in this face: everything the renderer can do, and
          // the overflow shows in the label's own box for the pixel gate
          assert.equal(m.fs, S.fontMin, `${tag}: fit-impossible word sits at fontMin`);
          assert.ok(m.sw > m.cw + 1, `${tag}: fit-impossible overflow is visible (sw ${m.sw} cw ${m.cw})`);
          continue;
        }
        assert.ok(m.sw <= m.cw + 1, `${tag}: no horizontal overflow (sw ${m.sw} cw ${m.cw})`);
        for (const w of m.words)
          assert.ok(w.l >= m.inner.l - 1 && w.r <= m.inner.r + 1,
            `${tag}: painted text ${w.l.toFixed(0)}..${w.r.toFixed(0)} inside tile ${m.inner.l.toFixed(0)}..${m.inner.r.toFixed(0)}`);
      }
      // the long words are exercised on the whole-word path, not only the
      // fit-impossible one: at least one of them fits here at some legal size
      const whole = labels.filter((m) => LONG.includes(m.text) && m.possible);
      assert.ok(whole.length >= 1, `long words on the whole-word path: ${whole.map((m) => m.text).join(", ")}`);
      // a long word that cannot be whole at the tile's start size shrinks;
      // the short word next to it keeps the contract font
      const go = labels.find((m) => m.text === "go");
      assert.ok(go.fs >= S.fontFloor - 0.5, `"go" keeps >= ${S.fontFloor}px (got ${go.fs})`);
      assert.deepEqual(errors, [], "no page errors");
      await ctx.close();
    } finally { await browser.close(); }
  });
}
