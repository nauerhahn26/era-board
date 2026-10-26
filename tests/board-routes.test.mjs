// Board Phase 0 route tests (T0.1 + T0.3).
// Spawns the selected server.js on an isolated TEST port and drives it
// with fetch. Run: node --test tests/board-routes.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.resolve(__dirname, "..");
// A standalone board run names its hub explicitly; gate copies resolve their
// own parent. Never fall back to another checkout's hub or private data.
const HUB = process.env.ERA_HUB_SRC ? path.resolve(process.env.ERA_HUB_SRC) : STUDIO;
assert.ok(fs.existsSync(path.join(HUB, 'server.js')), 'set ERA_HUB_SRC to the selected hub checkout');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'era-board-routes-'));
const SYMBOLS_CACHE = path.join(DATA, "symbols-cache");
const PORT = Number(process.env.ERA_BOARD_ROUTE_PORT || 8390);
assert.ok(PORT === 8390 || (Number.isInteger(PORT) && PORT >= 8380 && PORT <= 8389), 'approved test port');
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

let child, childTicks, provider;
const symbolRequests = [];
function startTicks(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]; }
  catch { return null; }
}
function listenerOwned() {
  const result = spawnSync('ss', ['-H', '-ltnp', `sport = :${PORT}`], { encoding: 'utf8' });
  const lines = result.stdout?.trim().split('\n').filter(Boolean) || [];
  return result.status === 0 && lines.length && lines.every(line => line.includes(`pid=${child.pid},`));
}

function waitFor(url, tries = 100) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error('owned test hub exited'));
      try {
        if (listenerOwned()) {
          const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
          if (response.ok && listenerOwned()) return resolve();
        }
      } catch {}
      if (--tries <= 0) return reject(new Error("server never came up"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

before(async () => {
  const available = spawnSync('ss', ['-H', '-ltn', `sport = :${PORT}`], { encoding: 'utf8' });
  assert.equal(available.status, 0, 'listener inspection succeeds');
  assert.equal(available.stdout.trim(), '', 'test port is free; leave an existing listener alone');
  for (const dir of ['recipes', 'wardrobe/outfits', 'gen-assets', 'symbols-cache']) {
    fs.mkdirSync(path.join(DATA, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(DATA, 'recipes/today.json'), JSON.stringify({ root: 'today', boards: [] }));
  fs.writeFileSync(path.join(DATA, 'wardrobe/outfits/outfit_0.jpg'), Buffer.from([255, 216, 255, 217]));
  fs.writeFileSync(path.join(DATA, 'gen-assets/yes.png'), PNG);
  provider = http.createServer((req, res) => {
    symbolRequests.push(req.url);
    if (req.url === '/images/41/41.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
    } else if (req.url.startsWith('/images/')) {
      res.writeHead(404).end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(req.url === '/search/apple' ? [{ _id: 41 }] : []));
    }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const env = { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: '127.0.0.1', ERA_DEVICE_ID: 'test',
    ERA_AI_URL: 'http://127.0.0.1:1', ERA_ELEVEN_URL: 'http://127.0.0.1:1',
    ERA_FAL_URL: 'http://127.0.0.1:1', ERA_GEO_URL: 'http://127.0.0.1:1/geo',
    ERA_WEATHER_URL: 'http://127.0.0.1:1', ERA_GEOCODE_URL: 'http://127.0.0.1:1/geocode',
    ERA_NWS_URL: 'http://127.0.0.1:1', ERA_RESEND_URL: 'http://127.0.0.1:1',
    ERA_TMDB_URL: 'http://127.0.0.1:1', ERA_STREAMING_URL: 'http://127.0.0.1:1',
    ERA_SYMBOL_SEARCH_URL: origin + '/search/', ERA_SYMBOL_IMAGE_URL: origin + '/images/{id}/{id}.png' };
  for (const key of ['ERA_PRESENCE_HOOK', 'ERA_BEACON_MS', 'ERA_BEACON_IDLE_MS', 'ERA_UPDATE_EVERY_MS', 'ERA_UPDATE_QUIET_MS']) delete env[key];
  child = spawn(process.execPath, [path.join(HUB, 'server.js'), String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env,
  });
  childTicks = startTicks(child.pid);
  await waitFor(`${BASE}/settings`);
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null && childTicks && startTicks(child.pid) === childTicks) {
    const args = spawnSync('ps', ['-ww', '-p', String(child.pid), '-o', 'args='], { encoding: 'utf8' });
    assert.equal(args.stdout.trim(), child.spawnargs.join(' '), 'only the captured test child is stopped');
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }
  if (provider) {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
  fs.rmSync(DATA, { recursive: true, force: true });
});

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
  assert.deepEqual(buf1, PNG, "the local provider's exact image bytes are served");
  assert.equal(r1.headers.get('x-symbol-cache'), 'miss');
  assert.ok(fs.existsSync(cacheFile), "cache file written after miss");

  const r2 = await fetch(`${BASE}/symbol/${name}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get("x-symbol-cache"), "hit", "second request served from cache");
  assert.equal(symbolRequests.filter(url => url === '/search/apple').length, 1, 'cache hit avoids another provider lookup');
  assert.equal(symbolRequests.filter(url => url === '/images/41/41.png').length, 1, 'image downloaded once');
});

test("symbol bad name rejected, unknown gibberish 404", async () => {
  const bad = await fetch(`${BASE}/symbol/%2e%2e%2fx`);
  assert.ok(bad.status === 404, `bad name -> 404 (got ${bad.status})`);
  assert.notEqual(bad.status, 200);

  const gib = await fetch(`${BASE}/symbol/zzxqwvbbqfoo`);
  assert.equal(gib.status, 404);
});
