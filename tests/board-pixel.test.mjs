// GATE 1 — pixel-audit invariants ported to /board/ (T1.2/T1.3 visual gate).
// Launches headless chromium against the LIVE server (read-only) at both
// 1920x1080 and 1280x720, over board states [root, a confirm_N, a cat_N,
// build]. Invariants: no .dwell target offscreen/occluded (center
// elementFromPoint returns the target), no horizontal scroll, min inter-target
// gap >= the contract's gapFloor (pairs under gapWarn are warnings; since 9/5
// warn == floor, so the warn band is retired), labels never overflow horizontally,
// computed label font-size >= 74px, chrome never wins a tile's center pixel,
// and (dad 9/2) the message bar is a <=9% strip holding only the exit door
// while every pictogram tile shows a real picture, not a speck.
// Runs under `node --test` or `node tests/board-pixel.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Thresholds come from the contract, never from a literal in here: a hard-coded
// 28/34 is exactly how the gap floor drifted away from the doc before (dad 9/5).
// This suite runs from two places — the gate's flat dir (era-hub/gate/, where
// ../public/lib is era-core/lib) and, in place, era-board/tests/ — so try both.
const CONTRACT = await (async () => {
  for (const p of ["../public/lib/contract.js", "../../era-core/lib/contract.js"]) {
    try { return (await import(new URL(p, import.meta.url))).CONTRACT; } catch { /* next */ }
  }
  throw new Error("lib/contract.js not found from " + import.meta.url);
})();
const S = CONTRACT.sizes;

const BASE = "http://localhost:8377/board/";
const SHOTS = fileURLToPath(new URL("./board-shots/", import.meta.url));
fs.mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [{ w: 1920, h: 1080 }, { w: 1280, h: 720 }];
// The old fourth state drove three message-bar chips; Speak/Clear and the chips
// strip that fed them are gone (dad 9/2), so the categories page she actually
// reaches from "Build my own" takes that slot instead.
const STATES = [
  { name: "root", setup: async (p) => {} },
  { name: "confirm_2", setup: async (p) => { await p.evaluate(() => window.Board.show("confirm_2")); } },
  { name: "cat_top", setup: async (p) => { await p.evaluate(() => window.Board.show("cat_top")); } },
  { name: "build", setup: async (p) => { await p.evaluate(() => window.Board.show("build")); } },
];

// C carries the contract thresholds across into the page (page.evaluate cannot
// import node modules), so the browser side has no numbers of its own either.
function MEASURE(C) {
  const vw = innerWidth, vh = innerHeight;
  const vis = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && cs.display !== "none" && cs.visibility !== "hidden" &&
      r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
  const lbl = (el) => el.id || el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 16) || String(el.className);
  const targets = [...document.querySelectorAll(".dwell")].filter(
    (el) => vis(el) && !el.hasAttribute("data-dwell-disabled") && el.getAttribute("aria-disabled") !== "true");
  const rects = targets.map((el) => ({ el, r: el.getBoundingClientRect(), label: lbl(el) }));

  const offscreen = [];
  for (const { r, label } of rects)
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5)
      offscreen.push({ label, l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) });

  const hscroll = document.documentElement.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1;

  const occluded = [], chromeWins = [];
  for (const { el, r, label } of rects) {
    const cx = Math.min(vw - 1, Math.max(1, (r.left + r.right) / 2));
    const cy = Math.min(vh - 1, Math.max(1, (r.top + r.bottom) / 2));
    const top = document.elementsFromPoint(cx, cy)[0];
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      occluded.push({ label, by: top.id || String(top.className).slice(0, 40) });
      if (top.closest && top.closest(".msgbar")) chromeWins.push({ label, by: String(top.className).slice(0, 40) });
    }
  }

  let minGap = Infinity, minPair = null; const warns = [];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i].r, b = rects[j].r;
    const dx = Math.max(a.left - b.right, b.left - a.right), dy = Math.max(a.top - b.bottom, b.top - a.bottom);
    const d = (dx < 0 && dy < 0) ? Math.max(dx, dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    if (d < minGap) { minGap = d; minPair = [rects[i].label, rects[j].label]; }
    // warn band: only meaningful while gapWarn > gapFloor. Since 9/5 they are
    // equal (the board draws exactly the floor), so this never fires.
    if (d < C.gapWarn && d >= C.gapFloor) warns.push({ a: rects[i].label, b: rects[j].label, gap: +d.toFixed(1) });
  }

  // WORD INTEGRITY (Gate-1): no partial words, ever.
  //  - CSS must only allow word-boundary wraps (no break-word/anywhere/hyphens)
  //  - no horizontal overflow (a whole word never exceeds its line box)
  //  - no vertical clipping (label rect fully inside its tile)
  const labelOverflow = [], fontViolations = [], breakRules = [], clipped = [], subFloor = [];
  for (const el of document.querySelectorAll(".tile-label")) {
    if (!vis(el)) continue;
    const t = (el.textContent || "").trim().slice(0, 20);
    const cs = getComputedStyle(el);
    if (cs.wordBreak !== "normal" || cs.hyphens === "auto" ||
        (cs.overflowWrap && cs.overflowWrap !== "normal"))
      breakRules.push({ t, wordBreak: cs.wordBreak, overflowWrap: cs.overflowWrap, hyphens: cs.hyphens });
    if (el.scrollWidth > el.clientWidth + 1)
      labelOverflow.push({ t, sw: el.scrollWidth, cw: el.clientWidth });
    const cell = el.closest(".cell");
    if (cell) {
      const lr = el.getBoundingClientRect(), cr = cell.getBoundingClientRect();
      if (lr.top < cr.top - 1 || lr.bottom > cr.bottom + 1)
        clipped.push({ t, lt: +lr.top.toFixed(1), lb: +lr.bottom.toFixed(1), ct: +cr.top.toFixed(1), cb: +cr.bottom.toFixed(1) });
      // half-leading descender allowance: css line-height 1.05 < the font's
      // natural box (~1.16em), so the last line "overflows" by a few px of
      // half-leading that paints into padding. A REAL clipped line would be a
      // whole line box (>=1.05em) — 9% of font size can never mask one.
      const fsz = parseFloat(cs.fontSize);
      if (el.scrollHeight > el.clientHeight + Math.max(3, fsz * 0.09))
        clipped.push({ t, sh: el.scrollHeight, ch: el.clientHeight });
    }
    const fs = parseFloat(cs.fontSize);
    if (el.classList.contains("plate")) {
      // photo-tile plate: SMALL BY DESIGN (dad 7/24 — the photo is the
      // message). Own floor only; exempt from the 74px text-tile floor.
      if (fs < 24 - 0.5) fontViolations.push({ t, fs: +fs.toFixed(1), photo: 1 });
    } else if (el.closest(".tile.weather")) {
      // weather plate: dad's EXPLICIT exception, 9/2 — "weather text is too big
      // cannot see sunny/cloudy image". The sun/cloud is the message and the
      // reading rides beside it, so this one label has its own smaller floor
      // (WEATHER_FONT_MIN) exactly like a photo tile's plate.
      if (fs < 36 - 0.5) fontViolations.push({ t, fs: +fs.toFixed(1), weather: 1 });
    } else if (fs < 44 - 0.5) fontViolations.push({ t, fs: +fs.toFixed(1) });          // absolute floor
    else if (fs < 74 - 0.5) {
      // <74 tolerated ONLY as the renderer's marked, fit-impossible fallback
      if (el.dataset.fontReduced === "1") subFloor.push({ t, fs: +fs.toFixed(1) });
      else fontViolations.push({ t, fs: +fs.toFixed(1) });
    }
  }
  // PHOTO SHARE (dad 7/24): on a photo tile the photo keeps ~4/5 of the cell.
  // Report every share; the threshold is viewport-aware outside (small
  // viewports pay the fixed 52px plate minimum).
  const photoShares = [];
  for (const tile of document.querySelectorAll(".tile.photo")) {
    if (!vis(tile)) continue;
    const img = tile.querySelector(".photo-img");
    if (!img) continue;
    const share = img.getBoundingClientRect().height / tile.getBoundingClientRect().height;
    const t = ((tile.querySelector(".tile-label") || {}).textContent || "").trim().slice(0, 20);
    photoShares.push({ t, share: +share.toFixed(2) });
  }
  // SLIM BAR (dad 9/2 "the header is still too big"): the message bar is a
  // strip, never more than 9% of the screen, and it carries the exit door and
  // nothing else — no Speak, no Clear, no chips.
  // AMENDED 9/4 (T4.4, dad's amendment): one pointer-only #partnerStrip may
  // ride at the far end of the bar on the songs and movies boards — the
  // grown-up's "+ Add / ⇅ Arrange". It is not a BAR_EXTRA. What is NOT allowed,
  // ever, is a second dwell target in the bar: the door is the only one, so the
  // strip is audited for that instead (board-partner-strip.test.mjs pins the
  // rest of it, including that her outfit board carries no strip at all).
  const barEl = document.querySelector(".msgbar");
  const barPct = barEl ? +((barEl.getBoundingClientRect().height / vh) * 100).toFixed(1) : null;
  const barExtras = barEl ? [...barEl.children].map((el) => el.id || String(el.className))
                                               .filter((n) => n !== "barDoor" && n !== "partnerStrip") : [];
  const barStrips = barEl ? barEl.querySelectorAll("#partnerStrip").length : 0;
  const barDwellExtras = barEl ? [...barEl.querySelectorAll(".dwell")].map(lbl).filter((n) => n !== "barDoor") : [];
  // BIG PICTURES (dad 9/2 "change bottoms image for bottoms is too small"):
  // every pictogram tile shows a real picture, never a speck above the word.
  const iconSqueezed = [];
  for (const tile of document.querySelectorAll(".tile.icon")) {
    if (!vis(tile)) continue;
    const img = tile.querySelector(".tile-img");
    if (!img || !vis(img)) continue;
    const tr = tile.getBoundingClientRect(), ir = img.getBoundingClientRect();
    const wShare = ir.width / tr.width, hShare = ir.height / tr.height;
    const t = ((tile.querySelector(".tile-label") || {}).textContent || "").trim().slice(0, 20);
    if (wShare < 0.20 || hShare < 0.20)
      iconSqueezed.push({ t, w: +wShare.toFixed(2), h: +hShare.toFixed(2) });
  }
  // FILL (Gate-1 "use the screen"): the grid must span the available width.
  let fillPct = null;
  const cells = [...document.querySelectorAll(".board-area .cell")].filter(vis);
  if (cells.length) {
    let L = Infinity, R = -Infinity;
    for (const c of cells) { const r = c.getBoundingClientRect(); L = Math.min(L, r.left); R = Math.max(R, r.right); }
    // denominator = the width the renderer is allowed to use, i.e. the contract's
    // board side pad on each edge (was a hard-coded 48 — the old <=48 ceiling —
    // which stopped matching the renderer the moment the pad moved; dad 9/5).
    fillPct = +(((R - L) / (vw - 2 * C.sidePad)) * 100).toFixed(1);
  }

  return { vw, vh, nTargets: rects.length, offscreen, hscroll, occluded, chromeWins,
    minGap: rects.length > 1 ? +minGap.toFixed(1) : null, minPair,
    warnCount: warns.length, warns: warns.slice(0, 6),
    labelOverflow, fontViolations, breakRules, clipped, subFloor, fillPct, photoShares,
    barPct, barExtras, barStrips, barDwellExtras, iconSqueezed };
}

test("board pixel gate — invariants at 1920x1080 and 1280x720", async () => {
  const browser = await chromium.launch();
  const violations = [];
  const summary = [];
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      // keep the run hermetic + fast (don't depend on ElevenLabs / logging)
      await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
      await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" })); // hermetic: never write her real pick history
      await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
      await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
      const page = await ctx.newPage();
      page.on("pageerror", (e) => { violations.push(`PAGEERROR ${vp.w}x${vp.h}: ${e.message}`); });
      for (const st of STATES) {
        await page.goto(BASE, { waitUntil: "load" });
        await page.waitForFunction(() => window.Board && typeof window.Board.show === "function", null, { timeout: 8000 });
        await st.setup(page);
        await page.waitForTimeout(350);
        const m = await page.evaluate(MEASURE,
          { gapFloor: S.gapFloor, gapWarn: S.gapWarn, sidePad: S.sidePadBoard });
        const shot = `${st.name}_${vp.w}x${vp.h}.png`;
        await page.screenshot({ path: SHOTS + shot });
        summary.push(`${st.name} ${vp.w}x${vp.h}: targets=${m.nTargets} minGap=${m.minGap} warns=${m.warnCount} fill=${m.fillPct}%`
          + (m.subFloor.length ? ` SUBFLOOR=${JSON.stringify(m.subFloor)}` : ""));

        const tag = `${st.name}@${vp.w}x${vp.h}`;
        if (m.offscreen.length) violations.push(`${tag} OFFSCREEN ${JSON.stringify(m.offscreen)}`);
        if (m.hscroll) violations.push(`${tag} HSCROLL`);
        if (m.occluded.length) violations.push(`${tag} OCCLUDED ${JSON.stringify(m.occluded)}`);
        if (m.chromeWins.length) violations.push(`${tag} CHROME_WINS ${JSON.stringify(m.chromeWins)}`);
        // the floor is the contract's (14 since dad's 9/5 tablet-spacing ruling);
        // -0.5 absorbs sub-pixel rounding on a grid that draws exactly the floor
        if (m.minGap != null && m.minGap < S.gapFloor - 0.5) violations.push(`${tag} MINGAP ${m.minGap} ${JSON.stringify(m.minPair)}`);
        // word integrity — the app's core constraint (she is learning to read)
        if (m.breakRules.length) violations.push(`${tag} BREAK_CSS ${JSON.stringify(m.breakRules)}`);
        if (m.labelOverflow.length) violations.push(`${tag} PARTIAL_WORD ${JSON.stringify(m.labelOverflow)}`);
        if (m.clipped.length) violations.push(`${tag} LABEL_CLIPPED ${JSON.stringify(m.clipped)}`);
        if (m.fontViolations.length) violations.push(`${tag} FONT_VIOLATION ${JSON.stringify(m.fontViolations)}`);
        // <74 fallback is never acceptable at 1920x1080 (room is plentiful)
        if (vp.w >= 1920 && m.subFloor.length) violations.push(`${tag} FONT<74@1920 ${JSON.stringify(m.subFloor)}`);
        // use the screen: grid must span >=90% of the allowed width
        if (m.fillPct != null && m.fillPct < 90) violations.push(`${tag} UNDERFILL ${m.fillPct}%`);
        // photo tiles keep ~4/5 of the cell: >=72% on real-device viewports
        // (>=1920); >=60% hard floor on the synthetic 720p (fixed 52px plate
        // minimum dominates the shorter tiles there)
        const shareFloor = vp.w >= 1920 ? 0.72 : 0.60;
        const squeezed = (m.photoShares || []).filter(p => p.share < shareFloor);
        if (squeezed.length) violations.push(`${tag} PHOTO_SQUEEZED ${JSON.stringify(squeezed)}`);
        // dad 9/2: slim bar, door only, and a real picture on every icon tile
        if (m.barPct != null && m.barPct > 9.1) violations.push(`${tag} BAR_TOO_TALL ${m.barPct}%`);
        if (m.barExtras.length) violations.push(`${tag} BAR_EXTRAS ${JSON.stringify(m.barExtras)}`);
        // 9/4 amendment: at most one partner strip, and never a second dwell
        // target in the bar — the door keeps that on every board.
        if (m.barStrips > 1) violations.push(`${tag} BAR_STRIPS ${m.barStrips}`);
        if (m.barDwellExtras.length) violations.push(`${tag} BAR_DWELL_EXTRAS ${JSON.stringify(m.barDwellExtras)}`);
        if (m.iconSqueezed.length) violations.push(`${tag} ICON_SQUEEZED ${JSON.stringify(m.iconSqueezed)}`);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log("PIXEL GATE SUMMARY:\n" + summary.join("\n"));
  assert.deepEqual(violations, [], "pixel invariants must hold at both viewports");
});
