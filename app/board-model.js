// board-model.js — pure recipe loader + navigation state machine (T1.1).
// No DOM: runs under `node --test` and in the browser as an ES module.
//
// A "recipe" is the JSON served at /recipes/today.json. loadRecipe() normalizes
// it (boards keyed by id, per-button defaults). createSession() wraps a model in
// a nav state machine: current board, history stack, load/back/home, leaf
// activation (speak vs bar-append), and freshness reload.

// ---- normalization ---------------------------------------------------------

// Per-button defaults: `say` falls back to `label`; `bar` (append-to-message-bar
// flag, schema addition) defaults false everywhere in v1.
function normalizeButton(btn) {
  const b = Object.assign({}, btn);
  if (b.say == null) b.say = b.label;
  if (typeof b.bar !== "boolean") b.bar = false;
  return b;
}

function normalizeBoard(board) {
  return Object.assign({}, board, {
    buttons: (board.buttons || []).map(normalizeButton),
  });
}

// loadRecipe(json) -> { root, boards:Map<id,board>, locale, home_label,
//                       home_symbol, home_image }
export function loadRecipe(json) {
  const boards = new Map();
  for (const raw of json.boards || []) boards.set(raw.id, normalizeBoard(raw));
  return {
    root: json.root,
    boards,
    locale: json.locale || "en",
    home_label: json.home_label || "",
    home_symbol: json.home_symbol || "",
    home_image: json.home_image || "",
  };
}

// ---- nav state machine -----------------------------------------------------

export function createSession(json) {
  let model = loadRecipe(json);
  let currentId = model.root;
  let history = []; // ids of boards we can back() to (does NOT include current)

  function boardOf(id) { return model.boards.get(id) || null; }

  const session = {
    get model() { return model; },
    get current() { return boardOf(currentId); },
    get currentId() { return currentId; },
    get history() { return history.slice(); },

    // navigate(load): push current onto history, move to `load`. Unknown target
    // => stay put + warn (never crash), history untouched.
    navigate(load) {
      if (!model.boards.has(load)) {
        console.warn("[board] unknown load target: " + load + " (staying on " + currentId + ")");
        return this.current;
      }
      if (load !== currentId) {
        history.push(currentId);
        currentId = load;
      }
      return this.current;
    },

    // back(): pop history. At the root / empty history it's a safe no-op.
    back() {
      if (history.length) currentId = history.pop();
      return this.current;
    },

    // home(): jump straight to root, clearing history.
    home() {
      currentId = model.root;
      history = [];
      return this.current;
    },

    // activate(button): the one decision point for a tap/dwell fire.
    //   load button  -> navigate, return { navigated: id }
    //   bar:true      -> return { append: {label, image, symbol} }
    //   otherwise     -> leaf, return { speak: say||label }
    activate(button) {
      if (!button) return {};
      if (button.load != null) {
        this.navigate(button.load);
        const out = { navigated: button.load };
        // Most doors are SILENT (D30). A door may opt into speaking as it
        // navigates via `say_on_load` — the outfit tiles on the today page do
        // this so the first pick is voiced (dad 7/24).
        if (button.say_on_load) out.speak = button.say != null ? button.say : button.label;
        return out;
      }
      if (button.bar) {
        return { append: { label: button.label, image: button.image, symbol: button.symbol } };
      }
      return { speak: button.say != null ? button.say : button.label };
    },

    // acceptNewRecipe(json): swap boards in place. Keep her where she is if that
    // board still exists; otherwise reset to root (and drop stale history).
    acceptNewRecipe(json) {
      model = loadRecipe(json);
      if (!model.boards.has(currentId)) {
        currentId = model.root;
        history = [];
      } else {
        // prune any history entries that no longer exist
        history = history.filter((id) => model.boards.has(id));
      }
      return this.current;
    },
  };

  return session;
}
