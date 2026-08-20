// Board Phase 0 route tests (T0.1 + T0.3).
// Spawns the REAL server.js on a TEST port (never the live 8377) and drives it
// with fetch. Run: node --test tests/board-routes.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.resolve(__dirname, "..");
// era layout: the hub serves everything; state lives in the overlay data dir.
const HUB = path.resolve(STUDIO, "../era-hub");
const DATA = process.env.ERA_DATA_DIR || path.resolve(STUDIO, "../era-family/data");
const SYMBOLS_CACHE = path.join(DATA, "symbols-cache");
const PORT = 8390;
const BASE = `http://127.0.0.1:${PORT}`;

let child;

function waitFor(url, tries = 100) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { await fetch(url); return resolve(); } catch {}
      if (--tries <= 0) return reject(new Error("server never came up"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

before(async () => {
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1" },
  });
  await waitFor(`${BASE}/settings`);
});

after(() => { if (child) child.kill("SIGKILL"); });

// ---------- T0.1: /recipes/today.json newest-wins + ETag/304 ----------
test("recipes/today.json serves the data-dir recipe, with ETag", async () => {
  const expected = fs.readFileSync(path.join(DATA, "recipes/today.json"), "utf8");

  const r = await fetch(`${BASE}/recipes/today.json`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /application\/json/);
  const etag = r.headers.get("etag");
  assert.ok(etag, "ETag header present");
  assert.equal(await r.text(), expected, "body is the newer file");

  // If-None-Match -> 304
  const r2 = await fetch(`${BASE}/recipes/today.json`, { headers: { "If-None-Match": etag } });
  assert.equal(r2.status, 304);

  // HEAD -> 200 + ETag, empty body
  const r3 = await fetch(`${BASE}/recipes/today.json`, { method: "HEAD" });
  assert.equal(r3.status, 200);
  assert.ok(r3.headers.get("etag"));
  assert.equal(await r3.text(), "");
});

// ---------- T0.1: /wardrobe/* ----------
test("wardrobe jpg served 200; traversal blocked; unknown 404", async () => {
  const r = await fetch(`${BASE}/wardrobe/outfits/outfit_0.jpg`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /image\/jpeg/);

  // encoded traversal must not escape the jail
  const t = await fetch(`${BASE}/wardrobe/%2e%2e%2f%2e%2e%2fserver.js`);
  assert.ok(t.status === 400 || t.status === 404, `traversal blocked (got ${t.status})`);
  assert.notEqual(t.status, 200);

  const u = await fetch(`${BASE}/wardrobe/nope-does-not-exist.jpg`);
  assert.equal(u.status, 404);

  // non-image extension rejected
  const x = await fetch(`${BASE}/wardrobe/wardrobe.json`);
  assert.ok(x.status === 400 || x.status === 404, `non-image rejected (got ${x.status})`);
});

// ---------- T0.1: /gen-assets/* ----------
test("gen-assets png served 200; unknown 404", async () => {
  const r = await fetch(`${BASE}/gen-assets/yes.png`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /image\/png/);

  const u = await fetch(`${BASE}/gen-assets/nope.png`);
  assert.equal(u.status, 404);
});

// ---------- T0.3: /symbol/:name ----------
test("symbol known name 200 png, second request is a cache hit", async () => {
  const name = "apple"; // not in the pre-warm set -> we control the cache
  const cacheFile = path.join(SYMBOLS_CACHE, `${name}.png`);
  try { fs.unlinkSync(cacheFile); } catch {}

  const r1 = await fetch(`${BASE}/symbol/${name}`);
  assert.equal(r1.status, 200);
  assert.match(r1.headers.get("content-type") || "", /image\/png/);
  const buf1 = Buffer.from(await r1.arrayBuffer());
  assert.ok(buf1.length > 100, "got real PNG bytes");
  assert.ok(fs.existsSync(cacheFile), "cache file written after miss");

  const r2 = await fetch(`${BASE}/symbol/${name}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get("x-symbol-cache"), "hit", "second request served from cache");
});

test("symbol bad name rejected, unknown gibberish 404", async () => {
  const bad = await fetch(`${BASE}/symbol/%2e%2e%2fx`);
  assert.ok(bad.status === 404, `bad name -> 404 (got ${bad.status})`);
  assert.notEqual(bad.status, 200);

  const gib = await fetch(`${BASE}/symbol/zzxqwvbbqfoo`);
  assert.equal(gib.status, 404);
});
