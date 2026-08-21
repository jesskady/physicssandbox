# physicssandbox

Browser-based physics sandbox: build structures out of dots, lines, and muscles,
then hit Play and watch them fall, bounce, and crawl.

Open `index.html` in a browser — no build step, no dependencies.

## Layout

- **Left quarter** — Wave menu. A vertical sine wave (x = sin(y)) with one dot
  per muscle. During Play the wave rolls downward; each muscle's expansion /
  contraction follows its dot's x-position on the wave (right = expanded,
  left = contracted). Sliders for wave speed and amplitude, each with min/max
  input boxes.
- **Center half** — Play area. A closed box whose four sides are solid.
- **Right quarter** — Physics menu. Play/Stop button, gravity slider with
  min/max inputs, rubber (bounciness) slider, Clear All.

## Building controls

| Action | How |
|---|---|
| Place dot | Click empty space |
| Draw line | Drag from one dot, release on another |
| Add muscle | Click anywhere on a line (hovering a bare line previews the pending muscle; a new muscle and its wave dot start highlighted green, with the wave dot at the exact center of the wave menu) |
| Move dot | Shift + drag the dot |
| Delete dot / muscle / line | Right-click it |
| Tune a muscle | Drag its dot anywhere on the wave menu. The dot is a fixed control point — it never moves on its own. Vertical placement sets its phase within the wave period; horizontal placement sets signed strength (center = no movement, right of center = expands first, left of center = contracts first) |

Hovering a muscle highlights its wave-menu dot in green, and vice versa.

**Select mode** (Mode button in the right panel): drag dots freely without
Shift; drag on empty space to rubber-band a box around multiple dots; then
dragging any selected dot moves the whole selection together. Click empty
space to deselect. Toggle back to Add mode to place dots/lines/muscles.

## Physics

Custom Verlet integration with iterative distance constraints (no engine
dependency):

- **Deterministic and device-independent.** The simulation runs in a fixed
  800×800 virtual world (the canvas just scales it to fit the screen), steps
  at a fixed 60 Hz timestep decoupled from the display's frame rate, and uses
  only bit-exact IEEE floating-point operations (`Math.sin`/`Math.hypot`/
  `Math.pow`, which can differ between browser engines, are replaced with
  exact-op equivalents in physics code). Identical dot placements + settings
  produce the identical run on any device or browser.
- **Dots** are point masses — the only things with collision (against the four
  walls).
- **Lines** are distance constraints, solved 8 iterations × 4 substeps per
  physics tick, which keeps structures stable instead of exploding.
- **Muscles** oscillate a line's rest length symmetrically about its center:
  `rest × (1 + waveAmp × (dotX − 0.5)·2 × sin(dotY·2π − waveT))`, where
  (dotX, dotY) is the muscle's fixed dot position on the wave menu (0..1).
- **Rubber** is wall restitution (0 = dead stop, 1 = full bounce), applied by
  reflecting the implicit Verlet velocity at contact. The floor also applies a
  little friction so structures can push against it and walk.

## Status

Initial draft. Ideas for next steps: dot–dot collision, save/load structures,
multiple wave shapes, per-muscle wave period multipliers.
