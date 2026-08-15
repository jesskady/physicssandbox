"use strict";

// ---------- Parameters ----------
const params = {
  gravity: 900,      // px/s^2
  rubber: 0.4,       // wall restitution 0..1
  stiffness: 0.6,    // non-muscle line rigidity 0..1; lower = stretchier frame
  waveSpeed: 3,      // rad/s — how fast the wave rolls
  waveAmp: 0.25,     // max fraction a muscle expands/contracts its line
  wallReverse: true, // flip wave direction when the structure hits a side wall
};

const DOT_R = 7;          // dot draw/collision radius
const MUSCLE_R = 9;       // muscle marker radius
const HIT_R = 12;         // click hit radius
const DAMPING = 0.995;    // velocity damping per substep
const MUSCLE_RAMP = 1.0;  // seconds to ease muscles in after Play, avoids a start-up jolt
const SUBSTEPS = 4;
const CONSTRAINT_ITERS = 8;
const TWO_PI = Math.PI * 2;
const HIGHLIGHT = "#0a0";

// ---------- State ----------
let dots = [];   // {id, x, y, px, py, bx, by}
let lines = [];  // {a, b, rest, muscle: null | {phase: 0..1, amp: 0..1}}
let mode = "build";  // "build" | "play"
let waveT = 0;       // wave phase offset, advances during play
let waveDir = 1;     // +1 or -1; wall hits flip it when params.wallReverse is on
let wasTouchingSide = false;  // side-wall contact last frame (edge trigger)
let lastFlipTime = -Infinity; // playTime of the last flip (cooldown)
const FLIP_COOLDOWN = 0.3;    // s — ignore re-hits right after a flip
let playTime = 0;    // seconds since Play was pressed
let hoveredMuscleLine = null;  // line whose muscle is hovered (either canvas)
let selectedMuscleLine = null; // just-added muscle, stays green until deselected
let pendingLine = null;        // un-muscled line under cursor — shows ghost muscle
let hoveredDot = null;         // dot under cursor: line-drag origin or destination
let dotIdSeq = 0;              // stable ids so undo/redo can rebuild a/b references

// select mode
let editMode = "add";          // "add" | "select" (build-time editing tool)
let selectedDots = new Set();  // multi-selected dots (select mode)
let boxSelect = null;          // {x0,y0,x1,y1} rubber-band rectangle in progress
let dragGroup = null;          // {lastX,lastY} dragging the selection

// interaction state
let dragLineFrom = null;    // dot we started a line-drag from
let dragMoveDot = null;     // dot being moved (shift+drag)
let dragWaveLine = null;    // line whose wave-dot is being dragged
let dragWaveLineStart = null; // {px, py} at the start of a wave-dot drag, to detect a real change
let mousePos = { x: 0, y: 0 };
let downPos = null;

// ---------- Canvas setup ----------
const playCanvas = document.getElementById("play-canvas");
const waveCanvas = document.getElementById("wave-canvas");
const pctx = playCanvas.getContext("2d");
const wctx = waveCanvas.getContext("2d");

function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}
function resizeAll() { resizeCanvas(playCanvas); resizeCanvas(waveCanvas); }
window.addEventListener("resize", resizeAll);

function playSize() {
  const r = playCanvas.getBoundingClientRect();
  return { w: r.width, h: r.height };
}
function waveSize() {
  const r = waveCanvas.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

// ---------- UI bindings ----------
function $(id) { return document.getElementById(id); }

// ---------- History (undo/redo) ----------
// Snapshot-based, unbounded: every committed edit stores a full copy of
// dots/lines. Dots carry a stable id and lines reference ids (not object
// identity) so a snapshot can rebuild fresh dot/line objects on restore.
// Physics stepping during Play never calls pushHistory, so simulation
// frames don't pollute the log — only build-mode edits do.
let history = [snapshotState()];
let historyIndex = 0;

function snapshotState() {
  return {
    dots: dots.map(d => ({ id: d.id, x: d.x, y: d.y, px: d.px, py: d.py, bx: d.bx, by: d.by })),
    lines: lines.map(l => ({
      aId: l.a.id,
      bId: l.b.id,
      rest: l.rest,
      muscle: l.muscle ? { px: l.muscle.px, py: l.muscle.py } : null,
    })),
  };
}

function restoreState(state) {
  const byId = new Map();
  dots = state.dots.map(d => {
    const nd = { id: d.id, x: d.x, y: d.y, px: d.px, py: d.py, bx: d.bx, by: d.by };
    byId.set(d.id, nd);
    return nd;
  });
  lines = state.lines.map(l => ({
    a: byId.get(l.aId),
    b: byId.get(l.bId),
    rest: l.rest,
    muscle: l.muscle ? { px: l.muscle.px, py: l.muscle.py } : null,
  }));
  resetInteractionState();
}

// Restoring swaps in fresh dot/line objects, so anything still pointing at
// the old ones (hover, selection, in-progress drags) has to be dropped.
function resetInteractionState() {
  hoveredMuscleLine = null;
  selectedMuscleLine = null;
  pendingLine = null;
  hoveredDot = null;
  selectedDots = new Set();
  boxSelect = null;
  dragGroup = null;
  dragLineFrom = null;
  dragMoveDot = null;
  dragWaveLine = null;
  dragWaveLineStart = null;
  downPos = null;
}

function pushHistory() {
  history = history.slice(0, historyIndex + 1);
  history.push(snapshotState());
  historyIndex = history.length - 1;
  updateHistoryButtons();
}

function undo() {
  if (historyIndex <= 0) return;
  if (mode === "play") stopPlay();
  historyIndex--;
  restoreState(history[historyIndex]);
  updateHistoryButtons();
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  if (mode === "play") stopPlay();
  historyIndex++;
  restoreState(history[historyIndex]);
  updateHistoryButtons();
}

const undoBtn = $("undo-btn");
const redoBtn = $("redo-btn");
function updateHistoryButtons() {
  undoBtn.disabled = historyIndex <= 0;
  redoBtn.disabled = historyIndex >= history.length - 1;
}
updateHistoryButtons();
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;  // don't hijack min/max box editing
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (key === "y") {
    e.preventDefault();
    redo();
  }
});

function bindSlider(id, key, minDef, maxDef, decimals, hasMinMax = true) {
  const slider = $(id);
  const label = $(id + "-val");
  slider.min = minDef;
  slider.max = maxDef;
  slider.value = params[key];
  const refresh = () => { label.textContent = Number(params[key]).toFixed(decimals); };
  slider.addEventListener("input", () => { params[key] = parseFloat(slider.value); refresh(); });
  if (hasMinMax) {
    const minBox = $(id + "-min"), maxBox = $(id + "-max");
    minBox.value = minDef;
    maxBox.value = maxDef;
    minBox.addEventListener("change", () => {
      slider.min = minBox.value;
      params[key] = parseFloat(slider.value);
      refresh();
    });
    maxBox.addEventListener("change", () => {
      slider.max = maxBox.value;
      params[key] = parseFloat(slider.value);
      refresh();
    });
  }
  refresh();
}

bindSlider("gravity", "gravity", 0, 2000, 0);
bindSlider("rubber", "rubber", 0, 1, 2, false);
bindSlider("stiffness", "stiffness", 0.05, 1, 2, false);
bindSlider("wave-speed", "waveSpeed", 0, 10, 2);
bindSlider("wave-amp", "waveAmp", 0, 0.6, 3);

const wallReverseBox = $("wall-reverse");
wallReverseBox.checked = params.wallReverse;
wallReverseBox.addEventListener("change", () => { params.wallReverse = wallReverseBox.checked; });

const playBtn = $("play-btn");
playBtn.addEventListener("click", () => (mode === "build" ? startPlay() : stopPlay()));

const modeBtn = $("mode-btn");
modeBtn.addEventListener("click", () => {
  editMode = editMode === "add" ? "select" : "add";
  modeBtn.textContent = editMode === "add" ? "Mode: Add" : "Mode: Select";
  selectedDots = new Set();
  boxSelect = null;
  dragGroup = null;
  dragLineFrom = null;
  dragMoveDot = null;
});

$("clear-btn").addEventListener("click", () => {
  if (mode === "play") stopPlay();
  if (dots.length === 0 && lines.length === 0) return;  // nothing to clear or undo
  dots = [];
  lines = [];
  resetInteractionState();
  pushHistory();
});

function startPlay() {
  mode = "play";
  waveT = 0;
  waveDir = 1;
  wasTouchingSide = false;
  lastFlipTime = -Infinity;
  playTime = 0;
  playBtn.textContent = "■ Stop";
  playBtn.classList.add("playing");
  for (const d of dots) {
    d.bx = d.x; d.by = d.y;   // remember build position
    d.px = d.x; d.py = d.y;   // zero initial velocity
  }
  for (const l of lines) l.rest = dist(l.a, l.b);
}

function stopPlay() {
  mode = "build";
  playBtn.textContent = "▶ Play";
  playBtn.classList.remove("playing");
  for (const d of dots) { d.x = d.bx; d.y = d.by; }
}

// ---------- Dot table ----------
// One row per dot with live X/Y fields. Rows resolve their dot by id at event
// time (never by captured object), since undo/redo swaps in fresh dot objects.
const dotListEl = $("dot-list");
let dotRows = new Map();  // id -> {row, xIn, yIn}
let dotListKey = null;    // joined ids of the rows currently built

function dotById(id) { return dots.find(d => d.id === id) || null; }

function selectDotById(id) {
  const d = dotById(id);
  if (d) selectedDots = new Set([d]);
}

function rebuildDotList() {
  dotRows = new Map();
  dotListEl.innerHTML = "";
  for (const dot of dots) {
    const id = dot.id;
    const row = document.createElement("div");
    row.className = "dot-row";
    const label = document.createElement("span");
    label.textContent = id + 1;
    const xIn = document.createElement("input");
    const yIn = document.createElement("input");
    for (const [inp, axis] of [[xIn, "x"], [yIn, "y"]]) {
      inp.type = "number";
      inp.step = "1";
      inp.addEventListener("focus", () => selectDotById(id));
      inp.addEventListener("input", () => {
        const d = dotById(id);
        const v = parseFloat(inp.value);
        if (!d || !isFinite(v)) return;
        d[axis] = v;
        d["p" + axis] = v;                       // no velocity kick
        if (mode === "build") d["b" + axis] = v; // build position only outside play
      });
      inp.addEventListener("change", () => { if (mode === "build") pushHistory(); });
    }
    row.addEventListener("click", () => selectDotById(id));
    row.append(label, xIn, yIn);
    dotListEl.append(row);
    dotRows.set(id, { row, xIn, yIn });
  }
}

function updateDotList() {
  const key = dots.map(d => d.id).join(",");
  if (key !== dotListKey) {
    dotListKey = key;
    rebuildDotList();
  }
  const active = document.activeElement;
  for (const d of dots) {
    const r = dotRows.get(d.id);
    if (!r) continue;
    const xv = String(Math.round(d.x)), yv = String(Math.round(d.y));
    if (active !== r.xIn && r.xIn.value !== xv) r.xIn.value = xv;
    if (active !== r.yIn && r.yIn.value !== yv) r.yIn.value = yv;
    r.row.classList.toggle("selected", selectedDots.has(d));
  }
}

// ---------- Muscle table ----------
// One row per muscle, labeled by the dots its line connects. Both coordinates
// display as -100..+100: X is signed strength (0 = center/still, + = expands
// first, matching the wave menu's − / + sides); Y is height in the wave menu
// (0 = the middle line, +100 = top, -100 = bottom). Internally px/py are 0..1
// top-left based. Rows resolve their line by the dot-id pair, which survives
// undo/redo rebuilds.
const muscleListEl = $("muscle-list");
let muscleRows = new Map();  // "aId-bId" -> {row, xIn, yIn}
let muscleListKey = null;

function muscleKey(l) { return l.a.id + "-" + l.b.id; }
function muscleLineByKey(k) {
  return lines.find(l => l.muscle && muscleKey(l) === k) || null;
}
function selectMuscleByKey(k) {
  const l = muscleLineByKey(k);
  if (l) selectedMuscleLine = l;
}

function rebuildMuscleList() {
  muscleRows = new Map();
  muscleListEl.innerHTML = "";
  for (const line of lines) {
    if (!line.muscle) continue;
    const key = muscleKey(line);
    const row = document.createElement("div");
    row.className = "dot-row";
    const label = document.createElement("span");
    label.textContent = (line.a.id + 1) + "–" + (line.b.id + 1);
    const xIn = document.createElement("input");
    const yIn = document.createElement("input");
    for (const inp of [xIn, yIn]) {
      inp.type = "number";
      inp.step = "1";
      inp.min = -100;
      inp.max = 100;
      inp.addEventListener("focus", () => selectMuscleByKey(key));
      inp.addEventListener("change", pushHistory);
    }
    xIn.addEventListener("input", () => {
      const l = muscleLineByKey(key);
      const v = parseFloat(xIn.value);
      if (!l || !isFinite(v)) return;
      l.muscle.px = (Math.max(-100, Math.min(100, v)) / 100 + 1) / 2;
    });
    yIn.addEventListener("input", () => {
      const l = muscleLineByKey(key);
      const v = parseFloat(yIn.value);
      if (!l || !isFinite(v)) return;
      l.muscle.py = 0.5 - Math.max(-100, Math.min(100, v)) / 200;
    });
    row.addEventListener("click", () => selectMuscleByKey(key));
    row.append(label, xIn, yIn);
    muscleListEl.append(row);
    muscleRows.set(key, { row, xIn, yIn });
  }
}

function updateMuscleList() {
  const muscled = lines.filter(l => l.muscle);
  const key = muscled.map(muscleKey).join(",");
  if (key !== muscleListKey) {
    muscleListKey = key;
    rebuildMuscleList();
  }
  const active = document.activeElement;
  for (const l of muscled) {
    const r = muscleRows.get(muscleKey(l));
    if (!r) continue;
    const xv = String(Math.round((l.muscle.px - 0.5) * 200));
    const yv = String(Math.round((0.5 - l.muscle.py) * 200));
    if (active !== r.xIn && r.xIn.value !== xv) r.xIn.value = xv;
    if (active !== r.yIn && r.yIn.value !== yv) r.yIn.value = yv;
    r.row.classList.toggle("selected", l === selectedMuscleLine);
  }
}

// ---------- List tabs ----------
const tabDotsBtn = $("tab-dots");
const tabMusclesBtn = $("tab-muscles");
function setListTab(tab) {
  const dotsOn = tab === "dots";
  tabDotsBtn.classList.toggle("active", dotsOn);
  tabMusclesBtn.classList.toggle("active", !dotsOn);
  $("dot-list-head").hidden = !dotsOn;
  dotListEl.hidden = !dotsOn;
  $("muscle-list-head").hidden = dotsOn;
  muscleListEl.hidden = dotsOn;
}
tabDotsBtn.addEventListener("click", () => setListTab("dots"));
tabMusclesBtn.addEventListener("click", () => setListTab("muscles"));

// ---------- Geometry helpers ----------
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) || 0.0001; }
function midpoint(l) { return { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }; }

function connected(a, b) {
  return lines.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
}
function dotAt(p) {
  for (let i = dots.length - 1; i >= 0; i--) {
    if (Math.hypot(dots[i].x - p.x, dots[i].y - p.y) <= HIT_R) return dots[i];
  }
  return null;
}
// All lines within LINE_HIT of p (anywhere along the segment), closest first.
// Crossing lines can overlap, so callers pick the candidate that suits them.
const LINE_HIT = 8;
function linesNear(p) {
  const res = [];
  for (const l of lines) {
    const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    let t = ((p.x - l.a.x) * dx + (p.y - l.a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = l.a.x + t * dx, cy = l.a.y + t * dy;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d <= LINE_HIT) res.push({ l, d });
  }
  return res.sort((a, b) => a.d - b.d).map(o => o.l);
}

// Modulation factor for a muscle, -1..+1. Its wave-menu dot is a FIXED control
// point: vertical placement = phase within the wave period, horizontal placement
// = signed strength (center = still, right = expands first, left = contracts first).
function muscleValue(m) {
  return (m.px - 0.5) * 2 * Math.sin(m.py * TWO_PI - waveT);
}

// ---------- Play-area interaction ----------
function canvasPos(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

playCanvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const p = canvasPos(e, playCanvas);
  downPos = p;
  if (mode !== "build") return;
  const d = dotAt(p);
  if (editMode === "select") {
    if (d) {
      // dragging any selected dot moves the whole selection with it
      if (!selectedDots.has(d)) selectedDots = new Set([d]);
      dragGroup = { lastX: p.x, lastY: p.y };
    } else {
      boxSelect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    }
    return;
  }
  if (d) {
    if (e.shiftKey) dragMoveDot = d;
    else dragLineFrom = d;
  }
});

// Drags are tracked on window (not the canvas) so straying outside the box
// mid-drag doesn't drop the operation — it ends only on button release.
// Positions clamp to the canvas edges while outside.
function playDragActive() { return !!(dragMoveDot || dragGroup || boxSelect || dragLineFrom); }
function clampToPlay(p) {
  const { w, h } = playSize();
  return { x: Math.max(0, Math.min(w, p.x)), y: Math.max(0, Math.min(h, p.y)) };
}

playCanvas.addEventListener("mousemove", (e) => {
  if (playDragActive()) return;  // window handler owns movement during drags
  const p = canvasPos(e, playCanvas);
  mousePos = p;
  // hover: a dot lights up as a line-drag origin; anywhere on a muscled line
  // highlights its muscle; a bare line previews a pending muscle
  hoveredDot = null;
  if (mode === "build") {
    const d = dotAt(p);
    if (d) hoveredDot = d;
  }
  hoveredMuscleLine = null;
  pendingLine = null;
  if (!hoveredDot) {
    const near = linesNear(p);
    const muscled = near.find(l => l.muscle);
    if (muscled) hoveredMuscleLine = muscled;
    else if (mode === "build" && editMode === "add" && near.length) pendingLine = near[0];
  }
});

window.addEventListener("mousemove", (e) => {
  if (dragWaveLine) {
    const p = canvasPos(e, waveCanvas);
    const { w, h } = waveSize();
    const m = dragWaveLine.muscle;
    m.px = Math.max(0, Math.min(1, p.x / w));
    m.py = Math.max(0, Math.min(1, p.y / h));
    return;
  }
  if (!playDragActive()) return;
  const raw = canvasPos(e, playCanvas);
  const p = clampToPlay(raw);
  mousePos = p;
  if (dragMoveDot) {
    dragMoveDot.x = p.x;
    dragMoveDot.y = p.y;
    return;
  }
  if (dragGroup) {
    const dx = p.x - dragGroup.lastX, dy = p.y - dragGroup.lastY;
    for (const d of selectedDots) { d.x += dx; d.y += dy; }
    dragGroup.lastX = p.x;
    dragGroup.lastY = p.y;
    return;
  }
  if (boxSelect) {
    boxSelect.x1 = p.x;
    boxSelect.y1 = p.y;
    return;
  }
  // dragLineFrom: track the destination dot (unclamped, so a dot near the
  // edge still catches a cursor slightly outside)
  hoveredDot = null;
  const d = dotAt(raw);
  if (d && d !== dragLineFrom) hoveredDot = d;
});

window.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  if (dragWaveLine) {
    if (dragWaveLineStart) {
      const m = dragWaveLine.muscle;
      if (m.px !== dragWaveLineStart.px || m.py !== dragWaveLineStart.py) pushHistory();
    }
    dragWaveLine = null;
    dragWaveLineStart = null;
    return;
  }
  if (!downPos) return;  // gesture didn't start on the play canvas
  const p = clampToPlay(canvasPos(e, playCanvas));
  const moved = downPos && Math.hypot(p.x - downPos.x, p.y - downPos.y) > 4;

  if (dragGroup) { if (moved) pushHistory(); dragGroup = null; downPos = null; return; }
  if (boxSelect) {
    const x0 = Math.min(boxSelect.x0, boxSelect.x1), x1 = Math.max(boxSelect.x0, boxSelect.x1);
    const y0 = Math.min(boxSelect.y0, boxSelect.y1), y1 = Math.max(boxSelect.y0, boxSelect.y1);
    if (x1 - x0 < 5 && y1 - y0 < 5) {
      selectedDots = new Set();  // plain click on empty space deselects
    } else {
      selectedDots = new Set(dots.filter(d => d.x >= x0 && d.x <= x1 && d.y >= y0 && d.y <= y1));
    }
    boxSelect = null;
    downPos = null;
    return;
  }
  if (editMode === "select") { downPos = null; return; }

  if (dragMoveDot) { if (moved) pushHistory(); dragMoveDot = null; downPos = null; return; }

  if (dragLineFrom) {
    const target = dotAt(p);
    if (target && target !== dragLineFrom && moved && !connected(dragLineFrom, target)) {
      lines.push({ a: dragLineFrom, b: target, rest: dist(dragLineFrom, target), muscle: null });
      pushHistory();
    }
    dragLineFrom = null;
    hoveredDot = null;  // drag-destination highlight; stale if released off-canvas
    if (moved) { downPos = null; return; }
    // fall through: an in-place click on a dot does nothing else
    downPos = null;
    return;
  }

  if (mode !== "build" || moved) { downPos = null; return; }

  // simple click: add a muscle anywhere on a bare line, else place a dot
  const near = linesNear(p);
  if (near.length) {
    const free = near.find(l => !l.muscle);
    if (free) {
      free.muscle = { px: 0.5, py: 0.5 };  // wave dot starts at menu center
      selectedMuscleLine = free;
      pushHistory();
    } else {
      selectedMuscleLine = near[0];        // clicking a muscled line selects it
    }
    downPos = null;
    return;
  }
  if (!dotAt(p)) {
    dots.push({ id: dotIdSeq++, x: p.x, y: p.y, px: p.x, py: p.y, bx: p.x, by: p.y });
    selectedMuscleLine = null;
    pushHistory();
  }
  downPos = null;
});

playCanvas.addEventListener("mouseleave", () => {
  // clear hover feedback only — active drags survive leaving the canvas
  hoveredMuscleLine = null;
  pendingLine = null;
  if (!dragLineFrom) hoveredDot = null;
});

// right-click delete: dot (and its lines) > muscle > line
playCanvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (mode !== "build") return;
  const p = canvasPos(e, playCanvas);
  const d = dotAt(p);
  let changed = false;
  if (d) {
    dots = dots.filter(x => x !== d);
    lines = lines.filter(l => l.a !== d && l.b !== d);
    selectedDots.delete(d);
    changed = true;
  } else {
    const near = linesNear(p);
    const muscled = near.find(l => l.muscle);
    if (muscled) { muscled.muscle = null; changed = true; }
    else if (near.length) { lines = lines.filter(x => x !== near[0]); changed = true; }
  }
  if (!lines.includes(selectedMuscleLine)) selectedMuscleLine = null;
  if (selectedMuscleLine && !selectedMuscleLine.muscle) selectedMuscleLine = null;
  if (changed) pushHistory();
});

// ---------- Wave-menu interaction ----------
function waveGeom() {
  const { w, h } = waveSize();
  const cx = w / 2;
  const ampMax = parseFloat($("wave-amp").max) || 0.6;
  const ampPx = Math.min(w * 0.42, (params.waveAmp / ampMax) * w * 0.42);
  return { w, h, cx, ampPx };
}

function waveDotPos(line) {
  const { w, h } = waveSize();
  return { x: line.muscle.px * w, y: line.muscle.py * h };
}

function waveDotAt(p) {
  // among overlapping wave dots, prefer the muscle selected in the play area,
  // then the closest
  let best = null, bestD = Infinity;
  for (const l of lines) {
    if (!l.muscle) continue;
    const wp = waveDotPos(l);
    const d = Math.hypot(wp.x - p.x, wp.y - p.y);
    if (d > HIT_R) continue;
    if (l === selectedMuscleLine) return l;
    if (d < bestD) { best = l; bestD = d; }
  }
  return best;
}

waveCanvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const p = canvasPos(e, waveCanvas);
  dragWaveLine = waveDotAt(p);
  if (dragWaveLine) {
    selectedMuscleLine = dragWaveLine;
    dragWaveLineStart = { px: dragWaveLine.muscle.px, py: dragWaveLine.muscle.py };
  }
});

waveCanvas.addEventListener("mousemove", (e) => {
  if (dragWaveLine) return;  // window handler owns movement during drags
  hoveredMuscleLine = waveDotAt(canvasPos(e, waveCanvas));
});

waveCanvas.addEventListener("mouseleave", () => {
  // clear hover feedback only — an active wave-dot drag survives leaving
  if (!dragWaveLine) hoveredMuscleLine = null;
});

// ---------- Physics (Verlet + distance constraints) ----------
function physicsStep(dt) {
  const h = dt / SUBSTEPS;
  const { w, h: ph } = playSize();

  for (let s = 0; s < SUBSTEPS; s++) {
    // integrate
    for (const d of dots) {
      const vx = (d.x - d.px) * DAMPING;
      const vy = (d.y - d.py) * DAMPING;
      d.px = d.x;
      d.py = d.y;
      d.x += vx;
      d.y += vy + params.gravity * h * h;
      d.hit = false;
    }

    // ease muscles in after Play so structures don't jolt on the first frames
    const r = Math.min(1, playTime / MUSCLE_RAMP);
    const ramp = r * r * (3 - 2 * r);
    // per-iteration correction so CONSTRAINT_ITERS passes compound to params.stiffness
    const iterK = 1 - Math.pow(1 - params.stiffness, 1 / CONSTRAINT_ITERS);

    // solve constraints
    for (let it = 0; it < CONSTRAINT_ITERS; it++) {
      // alternate sweep direction each pass — a fixed solve order biases
      // over-constrained rigs (e.g. cross-braced squares) into spinning
      const fwd = it % 2 === 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[fwd ? i : lines.length - 1 - i];
        let rest = l.rest;
        if (l.muscle) {
          rest = l.rest * (1 + params.waveAmp * ramp * muscleValue(l.muscle));
        }
        // muscles stay rigid (they drive the motion); plain lines can stretch
        const k = l.muscle ? 1 : iterK;
        const dx = l.b.x - l.a.x;
        const dy = l.b.y - l.a.y;
        const d = Math.hypot(dx, dy) || 0.0001;
        const diff = (d - rest) / d * 0.5 * k;
        l.a.x += dx * diff;
        l.a.y += dy * diff;
        l.b.x -= dx * diff;
        l.b.y -= dy * diff;
      }
      // walls (dots are the only colliders)
      for (const d of dots) collideWalls(d, w, ph);
    }

    // contact absorption: while a dot sits in a thin band against a wall,
    // scale its separation velocity by rubber. The clamp above only kills
    // the impact; without this, the springy line network re-launches the
    // structure and rubber 0 still bounces.
    const e = params.rubber;
    if (e < 1) {
      const band = DOT_R + 4;
      for (const d of dots) {
        if (d.hit) continue; // clamp already applied restitution this substep
        const vx = d.x - d.px, vy = d.y - d.py;
        if (d.y >= ph - band && vy < 0) d.py = d.y - vy * e;
        if (d.y <= band && vy > 0) d.py = d.y - vy * e;
        if (d.x >= w - band && vx < 0) d.px = d.x - vx * e;
        if (d.x <= band && vx > 0) d.px = d.x - vx * e;
      }
    }
  }

  // wall reverse: flip the wave direction when the structure reaches a side
  // wall, so a walker turns around and heads back. Edge-triggered (contact
  // must break before another flip) plus a short cooldown, so a structure
  // leaning on the wall doesn't flip every frame.
  if (params.wallReverse) {
    const touching = dots.some(d => d.x <= DOT_R + 0.5 || d.x >= w - DOT_R - 0.5);
    if (touching && !wasTouchingSide && playTime - lastFlipTime > FLIP_COOLDOWN) {
      waveDir = -waveDir;
      lastFlipTime = playTime;
    }
    wasTouchingSide = touching;
  }
}

function collideWalls(d, w, h) {
  const r = DOT_R;
  const e = params.rubber;
  if (d.x < r)      { const vx = d.x - d.px; d.x = r;     d.px = d.x + vx * e; d.hit = true; }
  if (d.x > w - r)  { const vx = d.x - d.px; d.x = w - r; d.px = d.x + vx * e; d.hit = true; }
  if (d.y < r)      { const vy = d.y - d.py; d.y = r;     d.py = d.y + vy * e; d.hit = true; }
  if (d.y > h - r)  {
    const vy = d.y - d.py;
    const vx = d.x - d.px;
    d.y = h - r;
    d.py = d.y + vy * e;
    d.px = d.x - vx * 0.85; // ground friction
    d.hit = true;
  }
}

// ---------- Rendering ----------
function drawPlay() {
  const { w, h } = playSize();
  pctx.clearRect(0, 0, w, h);

  // walls
  pctx.strokeStyle = "#000";
  pctx.lineWidth = 2;
  pctx.strokeRect(1, 1, w - 2, h - 2);

  // ghost line while dragging — green only when release would create a line
  const dragTargetOk = dragLineFrom && hoveredDot && !connected(dragLineFrom, hoveredDot);
  if (dragLineFrom) {
    pctx.save();
    pctx.setLineDash([5, 5]);
    pctx.strokeStyle = dragTargetOk ? HIGHLIGHT : "#888";
    pctx.lineWidth = 1.5;
    pctx.beginPath();
    pctx.moveTo(dragLineFrom.x, dragLineFrom.y);
    pctx.lineTo(mousePos.x, mousePos.y);
    pctx.stroke();
    pctx.restore();
  }

  // lines
  for (const l of lines) {
    pctx.strokeStyle = "#000";
    pctx.lineWidth = 2.5;
    pctx.beginPath();
    pctx.moveTo(l.a.x, l.a.y);
    pctx.lineTo(l.b.x, l.b.y);
    pctx.stroke();
  }

  // ghost preview of a pending muscle on the hovered bare line
  if (pendingLine && !pendingLine.muscle) {
    const m = midpoint(pendingLine);
    pctx.save();
    pctx.setLineDash([3, 3]);
    pctx.strokeStyle = "#888";
    pctx.lineWidth = 1.5;
    pctx.beginPath();
    pctx.arc(m.x, m.y, MUSCLE_R, 0, TWO_PI);
    pctx.stroke();
    pctx.restore();
  }

  // muscles (outlined circle at line center)
  for (const l of lines) {
    if (!l.muscle) continue;
    const m = midpoint(l);
    const hot = l === hoveredMuscleLine || l === selectedMuscleLine;
    pctx.strokeStyle = hot ? HIGHLIGHT : "#000";
    pctx.fillStyle = "#fff";
    pctx.lineWidth = 2;
    pctx.beginPath();
    pctx.arc(m.x, m.y, MUSCLE_R, 0, TWO_PI);
    pctx.fill();
    pctx.stroke();
    pctx.fillStyle = hot ? HIGHLIGHT : "#000";
    pctx.beginPath();
    pctx.arc(m.x, m.y, 3, 0, TWO_PI);
    pctx.fill();
  }

  // dots — green when ready to start a line, or as a valid drag destination;
  // an already-connected destination gets no highlight (release does nothing)
  for (const d of dots) {
    const hot = dragLineFrom
      ? d === dragLineFrom || (d === hoveredDot && dragTargetOk)
      : d === hoveredDot;
    pctx.fillStyle = hot ? HIGHLIGHT : "#000";
    pctx.beginPath();
    pctx.arc(d.x, d.y, DOT_R, 0, TWO_PI);
    pctx.fill();
    if ((d === hoveredDot && dragTargetOk) || selectedDots.has(d)) {
      // ring: valid line destination, or part of the multi-selection
      pctx.strokeStyle = HIGHLIGHT;
      pctx.lineWidth = 2;
      pctx.beginPath();
      pctx.arc(d.x, d.y, DOT_R + 4, 0, TWO_PI);
      pctx.stroke();
    }
  }

  // rubber-band selection box
  if (boxSelect) {
    pctx.save();
    pctx.setLineDash([4, 4]);
    pctx.strokeStyle = "#555";
    pctx.lineWidth = 1;
    pctx.strokeRect(
      Math.min(boxSelect.x0, boxSelect.x1),
      Math.min(boxSelect.y0, boxSelect.y1),
      Math.abs(boxSelect.x1 - boxSelect.x0),
      Math.abs(boxSelect.y1 - boxSelect.y0));
    pctx.restore();
  }
}

function drawWave() {
  const g = waveGeom();
  wctx.clearRect(0, 0, g.w, g.h);

  // ruler grid — horizontal guides at every eighth: middle darkest, quarters
  // medium, eighths light; vertical guides at every quarter (center axis included)
  wctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const y = (i / 8) * g.h;
    wctx.strokeStyle = i === 4 ? "#999" : (i % 2 === 0 ? "#ccc" : "#eee");
    wctx.beginPath();
    wctx.moveTo(0, y);
    wctx.lineTo(g.w, y);
    wctx.stroke();
  }
  wctx.strokeStyle = "#ccc";
  for (let i = 1; i < 4; i++) {
    const x = (i / 4) * g.w;
    wctx.beginPath();
    wctx.moveTo(x, 0);
    wctx.lineTo(x, g.h);
    wctx.stroke();
  }

  // the wave: x = cx + A*sin(2π·(y/h) − waveT), rolls downward during play
  wctx.strokeStyle = "#000";
  wctx.lineWidth = 1.5;
  wctx.beginPath();
  for (let y = 0; y <= g.h; y += 2) {
    const x = g.cx + g.ampPx * Math.sin((y / g.h) * TWO_PI - waveT);
    if (y === 0) wctx.moveTo(x, y);
    else wctx.lineTo(x, y);
  }
  wctx.stroke();

  // contraction/expansion labels
  wctx.fillStyle = "#999";
  wctx.font = "10px sans-serif";
  wctx.textAlign = "left";
  wctx.fillText("−", 4, 12);
  wctx.textAlign = "right";
  wctx.fillText("+", g.w - 4, 12);

  // one dot per muscle
  for (const l of lines) {
    if (!l.muscle) continue;
    const p = waveDotPos(l);
    const hot = l === hoveredMuscleLine || l === selectedMuscleLine;
    wctx.fillStyle = hot ? HIGHLIGHT : "#000";
    wctx.beginPath();
    wctx.arc(p.x, p.y, 6, 0, TWO_PI);
    wctx.fill();
    if (hot) {
      wctx.strokeStyle = HIGHLIGHT;
      wctx.lineWidth = 1.5;
      wctx.beginPath();
      wctx.arc(p.x, p.y, 10, 0, TWO_PI);
      wctx.stroke();
    }
  }
}

// ---------- Main loop ----------
let lastT = 0;
function frame(t) {
  const dt = Math.min(0.033, (t - lastT) / 1000 || 0.016);
  lastT = t;
  if (mode === "play") {
    waveT += waveDir * params.waveSpeed * dt;
    playTime += dt;
    physicsStep(dt);
  }
  updateDotList();
  updateMuscleList();
  drawPlay();
  drawWave();
  requestAnimationFrame(frame);
}

resizeAll();
requestAnimationFrame(frame);
