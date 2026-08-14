"use strict";

// ---------- Parameters ----------
const params = {
  gravity: 900,      // px/s^2
  rubber: 0.4,       // wall restitution 0..1
  waveSpeed: 3,      // rad/s — how fast the wave rolls
  waveAmp: 0.25,     // max fraction a muscle expands/contracts its line
};

const DOT_R = 7;          // dot draw/collision radius
const MUSCLE_R = 9;       // muscle marker radius
const HIT_R = 12;         // click hit radius
const DAMPING = 0.995;    // velocity damping per substep
const SUBSTEPS = 4;
const CONSTRAINT_ITERS = 8;
const TWO_PI = Math.PI * 2;
const HIGHLIGHT = "#0a0";

// ---------- State ----------
let dots = [];   // {x, y, px, py, bx, by}
let lines = [];  // {a, b, rest, muscle: null | {phase: 0..1, amp: 0..1}}
let mode = "build";  // "build" | "play"
let waveT = 0;       // wave phase offset, advances during play
let hoveredMuscleLine = null; // line whose muscle is hovered (either canvas)

// interaction state
let dragLineFrom = null;  // dot we started a line-drag from
let dragMoveDot = null;   // dot being moved (shift+drag)
let dragWaveLine = null;  // line whose wave-dot is being dragged
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
bindSlider("wave-speed", "waveSpeed", 0, 10, 2);
bindSlider("wave-amp", "waveAmp", 0, 0.6, 3);

const playBtn = $("play-btn");
playBtn.addEventListener("click", () => (mode === "build" ? startPlay() : stopPlay()));

$("clear-btn").addEventListener("click", () => {
  if (mode === "play") stopPlay();
  dots = [];
  lines = [];
});

function startPlay() {
  mode = "play";
  waveT = 0;
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

// ---------- Geometry helpers ----------
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) || 0.0001; }
function midpoint(l) { return { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }; }

function dotAt(p) {
  for (let i = dots.length - 1; i >= 0; i--) {
    if (Math.hypot(dots[i].x - p.x, dots[i].y - p.y) <= HIT_R) return dots[i];
  }
  return null;
}
function lineMidAt(p) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = midpoint(lines[i]);
    if (Math.hypot(m.x - p.x, m.y - p.y) <= HIT_R) return lines[i];
  }
  return null;
}
function lineAt(p) {
  // distance from point to segment
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    let t = ((p.x - l.a.x) * dx + (p.y - l.a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = l.a.x + t * dx, cy = l.a.y + t * dy;
    if (Math.hypot(p.x - cx, p.y - cy) <= 6) return l;
  }
  return null;
}

// Current expansion factor for a muscle: -1 (most contracted) .. +1 (most expanded)
function muscleSin(m) {
  return Math.sin(m.phase * TWO_PI - waveT);
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
  if (d) {
    if (e.shiftKey) dragMoveDot = d;
    else dragLineFrom = d;
  }
});

playCanvas.addEventListener("mousemove", (e) => {
  const p = canvasPos(e, playCanvas);
  mousePos = p;
  if (dragMoveDot) {
    dragMoveDot.x = p.x;
    dragMoveDot.y = p.y;
  }
  // hover detection for muscles
  hoveredMuscleLine = null;
  const l = lineMidAt(p);
  if (l && l.muscle) hoveredMuscleLine = l;
});

playCanvas.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  const p = canvasPos(e, playCanvas);
  const moved = downPos && Math.hypot(p.x - downPos.x, p.y - downPos.y) > 4;

  if (dragMoveDot) { dragMoveDot = null; downPos = null; return; }

  if (dragLineFrom) {
    const target = dotAt(p);
    if (target && target !== dragLineFrom && moved) {
      const exists = lines.some(l =>
        (l.a === dragLineFrom && l.b === target) || (l.b === dragLineFrom && l.a === target));
      if (!exists) {
        lines.push({ a: dragLineFrom, b: target, rest: dist(dragLineFrom, target), muscle: null });
      }
    }
    dragLineFrom = null;
    if (moved) { downPos = null; return; }
    // fall through: an in-place click on a dot does nothing else
    downPos = null;
    return;
  }

  if (mode !== "build" || moved) { downPos = null; return; }

  // simple click: add muscle if on a line middle, else place a dot
  const lm = lineMidAt(p);
  if (lm) {
    if (!lm.muscle) lm.muscle = { phase: 0.5, amp: 0.6 };
    downPos = null;
    return;
  }
  if (!dotAt(p) && !lineAt(p)) {
    dots.push({ x: p.x, y: p.y, px: p.x, py: p.y, bx: p.x, by: p.y });
  }
  downPos = null;
});

playCanvas.addEventListener("mouseleave", () => {
  dragLineFrom = null;
  dragMoveDot = null;
  hoveredMuscleLine = null;
});

// right-click delete: dot (and its lines) > muscle > line
playCanvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (mode !== "build") return;
  const p = canvasPos(e, playCanvas);
  const d = dotAt(p);
  if (d) {
    dots = dots.filter(x => x !== d);
    lines = lines.filter(l => l.a !== d && l.b !== d);
    return;
  }
  const lm = lineMidAt(p);
  if (lm && lm.muscle) { lm.muscle = null; return; }
  const l = lineAt(p);
  if (l) lines = lines.filter(x => x !== l);
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
  const g = waveGeom();
  const m = line.muscle;
  return {
    x: g.cx + g.ampPx * m.amp * muscleSin(m),
    y: m.phase * g.h,
  };
}

function waveDotAt(p) {
  for (const l of lines) {
    if (!l.muscle) continue;
    const wp = waveDotPos(l);
    if (Math.hypot(wp.x - p.x, wp.y - p.y) <= HIT_R) return l;
  }
  return null;
}

waveCanvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const p = canvasPos(e, waveCanvas);
  dragWaveLine = waveDotAt(p);
});

waveCanvas.addEventListener("mousemove", (e) => {
  const p = canvasPos(e, waveCanvas);
  if (dragWaveLine) {
    const g = waveGeom();
    const m = dragWaveLine.muscle;
    m.phase = Math.max(0, Math.min(1, p.y / g.h));                    // vertical = phase
    if (g.ampPx > 1) {
      m.amp = Math.max(0.05, Math.min(1, Math.abs(p.x - g.cx) / g.ampPx)); // horizontal = strength
    }
  } else {
    hoveredMuscleLine = waveDotAt(p);
  }
});

waveCanvas.addEventListener("mouseup", () => { dragWaveLine = null; });
waveCanvas.addEventListener("mouseleave", () => {
  dragWaveLine = null;
  hoveredMuscleLine = null;
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
    }

    // solve constraints
    for (let it = 0; it < CONSTRAINT_ITERS; it++) {
      for (const l of lines) {
        let rest = l.rest;
        if (l.muscle) {
          rest = l.rest * (1 + params.waveAmp * l.muscle.amp * muscleSin(l.muscle));
        }
        const dx = l.b.x - l.a.x;
        const dy = l.b.y - l.a.y;
        const d = Math.hypot(dx, dy) || 0.0001;
        const diff = (d - rest) / d * 0.5;
        l.a.x += dx * diff;
        l.a.y += dy * diff;
        l.b.x -= dx * diff;
        l.b.y -= dy * diff;
      }
      // walls (dots are the only colliders)
      for (const d of dots) collideWalls(d, w, ph);
    }
  }
}

function collideWalls(d, w, h) {
  const r = DOT_R;
  const e = params.rubber;
  if (d.x < r)      { const vx = d.x - d.px; d.x = r;     d.px = d.x + vx * e; }
  if (d.x > w - r)  { const vx = d.x - d.px; d.x = w - r; d.px = d.x + vx * e; }
  if (d.y < r)      { const vy = d.y - d.py; d.y = r;     d.py = d.y + vy * e; }
  if (d.y > h - r)  {
    const vy = d.y - d.py;
    const vx = d.x - d.px;
    d.y = h - r;
    d.py = d.y + vy * e;
    d.px = d.x - vx * 0.85; // ground friction
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

  // ghost line while dragging
  if (dragLineFrom) {
    pctx.save();
    pctx.setLineDash([5, 5]);
    pctx.strokeStyle = "#888";
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

  // muscles (outlined circle at line center)
  for (const l of lines) {
    if (!l.muscle) continue;
    const m = midpoint(l);
    const hot = l === hoveredMuscleLine;
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

  // dots
  for (const d of dots) {
    pctx.fillStyle = "#000";
    pctx.beginPath();
    pctx.arc(d.x, d.y, DOT_R, 0, TWO_PI);
    pctx.fill();
  }
}

function drawWave() {
  const g = waveGeom();
  wctx.clearRect(0, 0, g.w, g.h);

  // center axis
  wctx.strokeStyle = "#ccc";
  wctx.lineWidth = 1;
  wctx.beginPath();
  wctx.moveTo(g.cx, 0);
  wctx.lineTo(g.cx, g.h);
  wctx.stroke();

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
    const hot = l === hoveredMuscleLine;
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
    waveT += params.waveSpeed * dt;
    physicsStep(dt);
  }
  drawPlay();
  drawWave();
  requestAnimationFrame(frame);
}

resizeAll();
requestAnimationFrame(frame);
