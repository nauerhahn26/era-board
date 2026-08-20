// T1.1 — board-model.js unit tests (pure logic, no DOM). node --test.
// Drives the REAL served recipe: server serves the NEWEST of the two recipe
// paths by mtime; we mirror that here so we test exactly what she gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { loadRecipe, createSession } from "../public/board/board-model.js";

const DATA = process.env.ERA_DATA_DIR ||
  fileURLToPath(new URL("../../era-family/data", import.meta.url));
const RECIPE_PATHS = [
  DATA + "/recipes/today.json",
];
function newestRecipe() {
  let best = null;
  for (const p of RECIPE_PATHS) {
    try { const st = fs.statSync(p); if (!best || st.mtimeMs > best.st.mtimeMs) best = { p, st }; }
    catch { /* ignore */ }
  }
  if (!best) throw new Error("no recipe file found");
  return JSON.parse(fs.readFileSync(best.p, "utf8"));
}
const RECIPE = newestRecipe();

test("loadRecipe: normalizes root, boards map, and button defaults", () => {
  const m = loadRecipe(RECIPE);
  assert.equal(m.root, "today");
  assert.ok(m.boards instanceof Map, "boards is a Map");
  assert.ok(m.boards.has("today") && m.boards.has("confirm_0") && m.boards.has("cat_top"));
  assert.equal(m.boards.size, RECIPE.boards.length);

  // say fallback = label; bar defaults false; type preserved.
  const today = m.boards.get("today");
  // weather tile: find by its say SHAPE, never by today's band (warm/hot/cool vary daily)
  const weather = today.buttons.find(b => b.type === "control" && /degrees/.test(b.say || ""));
  // live recipe: exact temp/band vary by day — assert shape, not weather
  assert.match(weather.say, /^Today it is \w+, about -?\d+ degrees\.$/, "explicit say kept");
  assert.notEqual(weather.say, weather.label, "say is not the label fallback");
  // say-fallback: assert on a button that never carries an explicit say
  // ("Build my own" is on every today page); outfit tiles ALWAYS have an
  // explicit say and, since the variety rework, page 1 can lead with a
  // top+bottom pair whose say ("A and B") differs from its label ("A + b").
  const build = today.buttons.find(b => b.label === "Build my own");
  assert.equal(build.say, build.label, "say falls back to label");
  const outfit = today.buttons.find(b => b.type === "outfit");
  assert.equal(outfit.bar, false, "bar defaults false on outfit buttons");
  for (const b of today.buttons) assert.equal(typeof b.bar, "boolean");
});

test("nav: navigate + back history + home", () => {
  const s = createSession(RECIPE);
  assert.equal(s.current.id, "today", "starts at root");

  s.navigate("confirm_0");
  assert.equal(s.current.id, "confirm_0");
  s.back();
  assert.equal(s.current.id, "today", "back returns to today");

  // deeper stack: today -> today_2 -> build, then back twice.
  s.navigate("today_2");
  s.navigate("build");
  assert.equal(s.current.id, "build");
  s.back();
  assert.equal(s.current.id, "today_2");
  s.back();
  assert.equal(s.current.id, "today");

  // cat page reachable, then home from depth.
  s.navigate("build");
  s.navigate("cat_top");
  assert.equal(s.current.id, "cat_top");
  s.home();
  assert.equal(s.current.id, "today", "home jumps to root");
  s.back();
  assert.equal(s.current.id, "today", "back at root is a no-op (never crashes)");
});

test("nav: unknown load target stays put and warns (never crashes)", () => {
  const s = createSession(RECIPE);
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    s.navigate("does_not_exist");
  } finally {
    console.warn = orig;
  }
  assert.equal(s.current.id, "today", "stayed on current board");
  assert.equal(warnings.length, 1, "warned exactly once");
  assert.match(warnings[0], /does_not_exist/);
});

test("activate: load button navigates; leaf speaks say||label; bar flag appends", () => {
  const s = createSession(RECIPE);
  const today = s.current;

  // load button -> navigation; today outfits also speak on load (say_on_load)
  const outfit = today.buttons.find(b => b.load === "confirm_0");
  const r1 = s.activate(outfit);
  assert.equal(r1.navigated, "confirm_0");
  assert.equal(r1.speak, outfit.say, "outfit pick voices its say text as it navigates");
  assert.equal(s.current.id, "confirm_0");

  // a plain door (Back) has no say_on_load -> navigates SILENTLY (no speak)
  const back = s.current.buttons.find(b => b.type === "back");
  const rb = s.activate(back);
  assert.equal(rb.navigated != null, true, "back navigates");
  assert.equal(rb.speak, undefined, "plain door stays silent");
  s.navigate("confirm_0"); // return to confirm for the leaf/yes checks below

  // leaf outfit (the big preview on confirm_0 has no load, bar false) -> speak label
  const preview = s.current.buttons.find(b => b.type === "outfit" && !b.load);
  const r2 = s.activate(preview);
  // speaks say||label — say when present (pairs speak full names, "A and B")
  assert.deepEqual(r2, { speak: preview.say != null ? preview.say : preview.label });

  // yes button with explicit say -> speak "Yes"
  const yes = s.current.buttons.find(b => b.type === "yes");
  assert.deepEqual(s.activate(yes), { speak: "Yes" });
});

test("activate: bar:true button appends a chip instead of speaking", () => {
  const mini = {
    root: "r",
    boards: [
      { id: "r", rows: 1, columns: 2, buttons: [
        { label: "apple", type: "word", image: "wardrobe/x.jpg", bar: true },
        { label: "go", type: "word", symbol: "go", bar: true, say: "let's go" },
      ] },
    ],
  };
  const s = createSession(mini);
  const [apple, go] = s.current.buttons;
  assert.deepEqual(s.activate(apple), { append: { label: "apple", image: "wardrobe/x.jpg", symbol: undefined } });
  assert.deepEqual(s.activate(go), { append: { label: "go", image: undefined, symbol: "go" } });
});

test("freshness: acceptNewRecipe keeps current if it still exists, resets to root otherwise", () => {
  const s = createSession(RECIPE);
  s.navigate("cat_top");
  assert.equal(s.current.id, "cat_top");

  // new recipe still has cat_top -> stay
  s.acceptNewRecipe(RECIPE);
  assert.equal(s.current.id, "cat_top", "stays when board id survives");

  // new recipe drops cat_top -> reset to root
  const trimmed = {
    root: "today",
    boards: RECIPE.boards.filter(b => b.id !== "cat_top"),
  };
  s.acceptNewRecipe(trimmed);
  assert.equal(s.current.id, "today", "resets to root when current board is gone");
  // history cleared on reset
  s.back();
  assert.equal(s.current.id, "today");
});
