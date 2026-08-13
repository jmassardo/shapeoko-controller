# Panel specification (`hardware/panel-spec.yaml`)

`hardware/panel-spec.yaml` is the **single machine-readable source of truth** for
the physical operator panel of the Shapeoko controller. Every physical dimension
of the panel — its outline, mounting holes, and every control's position and
cutout — lives here and **only** here.

## Why this file is canonical

Historically every dimension existed only as SVG markup inside
`docs/hardware/panel-mockup.svg`, tangled up with gradients, label text, and
cosmetic geometry. Nothing could be generated from it and nothing could verify
it. This file fixes that:

- The mockup drawing (`docs/hardware/panel-mockup.svg`) is **generated** from
  this spec — issue #117.
- The CAD / DXF hole positions are **generated** from this spec — issue #124.

Because both are generated from one file, the drawing and the machined part
cannot drift apart. **Do not hand-edit coordinates or legends into the SVG or
the CAD.** Edit them here and regenerate.

> No coordinate literal for the panel should be duplicated anywhere outside this
> file.

## Units and coordinates

- **All lengths are millimetres.** `panel.units` is `mm` and the schema pins it.
- The SVG user unit is also 1 mm, so values transcribe 1:1 from the mockup.
- Origin is the panel's **top-left corner**, `+x` right, `+y` down.
- **Every control's `x`/`y` is the control CENTRE.** Round controls are drawn in
  the mockup as `<circle cx cy>` so they transcribe directly. Rectangular
  controls (the DSI screen, USB, LAN) are drawn as `<rect x y w h>` with a
  top-left origin; their `x`/`y` here are that origin plus half the drawn size.
  This is the only non-literal transcription and each such control carries a
  comment showing the conversion.
- The E-stop `plate` sub-object uses a **top-left origin** (`x, y, w, h`),
  exactly as the yellow-plate rectangle is drawn, because a plate is an area,
  not a control centre.

## Structure

```yaml
panel:
  units: mm
  width: 340
  height: 290
  corner_radius: 7
  thickness: null          # material/thickness is #125, not decided here
  min_web: 6               # minimum material between two control cutouts
  mounting_holes: [ ... ]  # four M4 corner fixings, hole centres

controls:
  - id: estop              # stable, unique, [a-z0-9_]
    label: EMERGENCY STOP  # panel legend
    sub_label: ...         # secondary legend (where the mockup shows one)
    type: estop_mushroom   # one of the closed enum below
    x: 290
    y: 47
    safety_critical: true
    cutout: { ... }        # geometry sufficient to machine the hole
    plate: { ... }         # E-stop only: the yellow legend plate
    notes: ...
```

### Control types (closed enum)

The schema (`hardware/panel-spec.schema.json`) accepts only these `type` values.
A control declaring anything else is rejected by the validator with the list of
legal types:

`estop_mushroom`, `illuminated_button_22`, `deadman_22`, `potentiometer`,
`rotary_selector`, `mpg_handwheel`, `led_indicator`, `dsi_screen`,
`usb_passthrough`, `lan_passthrough`.

### Cutout geometry

`cutout.kind` is `round` or `rect`.

- **`round`** — `diameter`, plus `anti_rotation_flat` for Ø22 panel mounts. The
  Ø22 controls specify the **22.5 mm bore** plus the anti-rotation flat offset,
  **not** the cosmetic bezel diameter shown on the mockup.
- **`rect`** — `w`, `h`, `corner_r`. The DSI screen additionally distinguishes
  three rectangles because the faceplate must be cut to the aperture and cleared
  for the module:
  - the visible **aperture** (`w`/`h`) — what is actually cut in the faceplate,
  - the **`module_envelope`** (165 × 100 mm) — what must be cleared behind,
  - the **`active_area`** (154 × 86 mm) — the illuminated LCD area.

## The DUST legend

The DUST button's `sub_label` is **`RF · auto · lit = confirmed`**. The dust
collector is commanded by an RF transmission (a cloned 433.92 MHz remote sent
from the ESP32 via CC1101 — #63, #137), and its lamp indicates *confirmed
running* from current-sense feedback (#138), not merely commanded state. It is
deliberately parallel in form to SPINDLE's `M3/M5 · lit = running`: both state
the mechanism and then what illumination means, because an operator reads them
side by side. There is **no switched-output device anywhere in the design**, so
the word "relay" must never appear in this spec.

## Validation

`hardware/tools/validate_panel_spec.py` validates the spec in four stages and
reports **all** failures, not just the first:

1. **YAML load** — malformed YAML fails with the parse location and no partial
   output.
2. **Schema** — structure, types, and the closed control-type enum.
3. **Geometry** — cutout overlap, panel-outline containment, and the declared
   `min_web` between control cutouts. Offending control ids are named.
4. **Safety distances (#115)** — encoded as named constants at the top of the
   validator:
   - ENABLE-to-MPG centre distance **≥ 250 mm** (currently 253.0 mm) so the
     deadman is not within reach of the handwheel.
   - RESET **outside** the E-stop yellow-plate bounds **and ≥ 75 mm** from the
     mushroom centre so it cannot be hit in place of the E-stop.
   - The E-stop must be flagged `safety_critical: true` and carry its `plate`.

> **Software never performs the emergency stop — it only observes.** These
> safety-distance rules are the mechanism that stops a later careless spec edit
> from putting the RESET button under the operator's palm or the deadman within
> reach of the handwheel. **Do not relax these constants to make an edit pass.**
> If a real coordinate violates a rule, that is a design finding to escalate
> (see #115), not a constant to lower.

### Running it

The toolchain is **isolated** under `hardware/` with its own `pyproject.toml`
(pinning `pyyaml` + `jsonschema`); it is not coupled to the Node workspaces or
PlatformIO. Use a virtual environment inside `hardware/` (do not install into
system Python):

```bash
cd hardware
python3 -m venv .venv
./.venv/bin/python -m pip install -e ".[dev]"

# validate the committed spec (prints the control count, exits 0 when valid)
./.venv/bin/python tools/validate_panel_spec.py

# run the validator unit tests
./.venv/bin/python -m pytest
```

The validator exits `0` and prints `VALID: panel spec OK, N controls.` when the
spec is valid; any failure exits non-zero and prints each problem.

## Editing checklist

1. Change coordinates/legends **here**, never in the SVG or CAD.
2. Keep every `x`/`y` as the control **centre**.
3. Run the validator; fix every reported problem.
4. Never edit a safety constant to silence a safety failure.
5. Regenerate the mockup (#117) and CAD (#124) from this file.
