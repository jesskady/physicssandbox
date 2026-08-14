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
| Add muscle | Click the middle of a line |
| Move dot | Shift + drag the dot |
| Delete dot / muscle / line | Right-click it |
| Tune a muscle | Drag its dot on the wave menu — vertical sets its phase in the wave period, horizontal sets its strength |

Hovering a muscle highlights its wave-menu dot in green, and vice versa.

## Physics

Custom Verlet integration with iterative distance constraints (no engine
dependency):

- **Dots** are point masses — the only things with collision (against the four
  walls).
- **Lines** are distance constraints, solved 8 iterations × 4 substeps per
  frame, which keeps structures stable instead of exploding.
- **Muscles** oscillate a line's rest length symmetrically about its center:
  `rest × (1 + waveAmp × strength × sin(phase·2π − waveT))`.
- **Rubber** is wall restitution (0 = dead stop, 1 = full bounce), applied by
  reflecting the implicit Verlet velocity at contact. The floor also applies a
  little friction so structures can push against it and walk.

## Status

Initial draft. Ideas for next steps: dot–dot collision, save/load structures,
multiple wave shapes, per-muscle wave period multipliers.
