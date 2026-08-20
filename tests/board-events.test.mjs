// Outfit pick telemetry tests (Phase 2, D49).
// Part 1: the client queue module (board-events.js) under node with a fake
// fetch/storage — enqueue never blocks, offline events persist and drain in
// order, a 400 drops the bad event instead of wedging the queue.
// Part 2: POST /outfit-event on the REAL server.js, spawned on a TEST port with
// ELLIE_WARDROBE_DIR pointing at a temp dir — her live history.json is never
// touched. Run: node --test tests/board-events.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOutfitEvents } from "../public/board/board-events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.resolve(__dirname, "..");
const PORT = 8391; // board-routes uses 8390; never the live 8377
const BASE = `http://127.0.0.1:${PORT}`;

// ---- part 1: client queue ---------------------------------------------------

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
}
const queued = (store) => JSON.parse(store.getItem("board:outfitEvents") || "[]");
const tick = () => new Promise((r) => setTimeout(r, 20));

test("send POSTs the event with kind + combo", async () => {
  const posts = [];
  const ev = createOutfitEvents({
    storage: fakeStorage(),
    fetchFn: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; },
  });
  ev.send("select", ["item_aa11", "item_bb22"]);
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/outfit-event");
  assert.equal(posts[0].body.kind, "select");
  assert.deepEqual(posts[0].body.combo, ["item_aa11", "item_bb22"]);
});

test("offline events persist in the queue, then drain IN ORDER when back", async () => {
  const store = fakeStorage();
  const posts = [];
  let up = false;
  const ev = createOutfitEvents({
    storage: store,
    retryMs: 5,
    fetchFn: async (_url, opts) => {
      if (!up) throw new Error("net down");
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 204 };
    },
  });
  ev.send("select", ["item_aa11"]);
  ev.send("yes", ["item_aa11"]);
  await tick();
  assert.equal(posts.length, 0, "nothing delivered while down");
  assert.equal(queued(store).length, 2, "both events queued");
  up = true;
  await ev.flush();
  await tick();
  assert.deepEqual(posts.map((p) => p.kind), ["select", "yes"], "drained in order");
  assert.equal(queued(store).length, 0, "queue empty after drain");
});

test("a 400 drops the bad event and keeps draining (never wedges)", async () => {
  const store = fakeStorage();
  const posts = [];
  const ev = createOutfitEvents({
    storage: store,
    fetchFn: async (_url, opts) => {
      const b = JSON.parse(opts.body);
      posts.push(b.kind);
      return b.kind === "bogus" ? { ok: false, status: 400 } : { ok: true, status: 204 };
    },
  });
  ev.send("bogus", ["item_aa11"]);
  ev.send("yes", ["item_aa11"]);
  await tick();
  assert.deepEqual(posts, ["bogus", "yes"], "400 event dropped, next delivered");
  assert.equal(queued(store).length, 0);
});

test("send without a combo is a no-op (never throws, never POSTs)", async () => {
  const posts = [];
  const ev = createOutfitEvents({ storage: fakeStorage(), fetchFn: async () => { posts.push(1); return { ok: true, status: 204 }; } });
  ev.send("select", []);
  ev.send("select", undefined);
  await tick();
  assert.equal(posts.length, 0);
});

// ---- part 2: the server endpoint (temp wardrobe, real server.js) ------------

let child;
let WDIR;
const HIST = () => path.join(WDIR, "history.json");
const readHist = () => JSON.parse(fs.readFileSync(HIST(), "utf8"));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

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
const post = (body) => fetch(`${BASE}/outfit-event`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

before(async () => {
  WDIR = fs.mkdtempSync(path.join(os.tmpdir(), "outfit-events-"));
  // pre-existing history: the endpoint must PRESERVE days written by the generator
  fs.writeFileSync(HIST(), JSON.stringify({ days: { "2026-08-04": { band: "hot", page1: [["item_aa11"]] } } }, null, 2));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: STUDIO, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELLIE_WARDROBE_DIR: WDIR },
  });
  await waitFor(`${BASE}/settings`);
});
after(() => { if (child) child.kill("SIGKILL"); });

test("valid select -> 204, appended under today's Pacific date", async () => {
  const r = await post({ kind: "select", combo: ["item_05f3cc46db", "item_8fe9749252"] });
  assert.equal(r.status, 204);
  const evs = readHist().events[today()];
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "select");
  assert.deepEqual(evs[0].combo, ["item_05f3cc46db", "item_8fe9749252"]);
});

test("yes event appends to the same day's list", async () => {
  const r = await post({ kind: "yes", combo: ["item_05f3cc46db", "item_8fe9749252"] });
  assert.equal(r.status, 204);
  const evs = readHist().events[today()];
  assert.equal(evs.length, 2);
  assert.equal(evs[1].kind, "yes");
});

test("generator-written days survive event writes", async () => {
  assert.deepEqual(readHist().days["2026-08-04"].page1, [["item_aa11"]]);
});

test("invalid payloads -> 400 and nothing recorded", async () => {
  const beforeLen = readHist().events[today()].length;
  for (const bad of [
    { kind: "worn", combo: ["item_aa11"] },            // unknown kind
    { kind: "yes", combo: [] },                          // empty combo
    { kind: "yes", combo: ["item_aa11", "item_bb22", "item_cc33"] }, // 3 pieces
    { kind: "yes", combo: ["../../etc/passwd"] },       // bad id shape
    { kind: "yes", combo: "item_aa11" },                 // not an array
    "not json at all",
  ]) {
    const r = await post(bad);
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(readHist().events[today()].length, beforeLen, "no bad event landed");
});
