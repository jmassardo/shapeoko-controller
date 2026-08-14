#!/usr/bin/env python3
"""Deterministically generate the panel mockup SVG from the canonical panel spec.

``docs/hardware/panel-mockup.svg`` is a GENERATED ARTIFACT of
``hardware/panel-spec.yaml`` (issue #117). It must never be hand-edited: a
wording or coordinate change is a spec edit, and CI regenerates the SVG and
diffs it against the committed copy (``check_generated_artifacts.sh``) so drift
becomes a red build instead of a scrapped faceplate.

Design contract
---------------
* ``generate_svg(spec)`` is a PURE function: parsed spec in, SVG string out.
  No timestamps, no randomised ids, no ``hash``-dependent iteration — the output
  is byte-identical across runs and across processes. Controls are emitted
  sorted by ``id`` and every float goes through :func:`_fmt`.
* The generator VALIDATES the spec first (via the #116 validator) and refuses to
  write any output when the spec is invalid, leaving the committed SVG untouched.
* Every drawing routine is looked up in :data:`_DISPATCH` keyed on the control
  ``type``. An unknown type fails loudly, NAMING the offending type, rather than
  silently emitting an SVG with a missing control.

What comes from the spec vs. what is cosmetic
---------------------------------------------
Every control ``label`` / ``sub_label`` drawn in the SVG is read from the spec.
**No legend string is hardcoded in this generator** — grep this file and you
will not find "EMERGENCY STOP", "DUST", "RF ...", etc. A legend change is a spec
edit, which is the entire point of the issue.

Two categories of text are deliberately NOT spec legends and live here as
clearly-marked cosmetic constants, because they have no ``label``/``sub_label``
field to source them from:

  * Purely decorative markings and fake UI: the "STOP" moulded on the mushroom,
    the fake DRO readout on the screen, the dial graduations (0/50/100/150/200,
    OFF/X/Y/Z, ×1/×10/×100, 50/100/150), and the dimension callouts.
  * The E-stop hazard clause (see :data:`_ESTOP_HAZARD_ANNOTATION`).

E-stop legend decision (documented as required by issue #117)
-------------------------------------------------------------
The spec's E-stop ``sub_label`` is only ``PULL TO RELEASE``, but the hand-authored
drawing read ``PULL TO RELEASE · CUTS SPINDLE + STEPPERS``. Dropping the hazard
clause to render the bare spec ``sub_label`` would silently remove a safety
statement from a safety drawing — worse than keeping one documented cosmetic
string in code. So we take option (b): render the spec ``label`` and
``sub_label`` verbatim and APPEND the hazard clause as an explicit, clearly
named cosmetic annotation constant. The spec text is still authoritative; the
clause is additive decoration only.

DUST / relay reconciliation (documented as required by issue #117)
------------------------------------------------------------------
The hand-authored SVG carried a stale ``relay out · auto w/ spindle`` sub-label
and an ``ESP32 relay output`` structural comment, both from a superseded design.
Dust collection is now commanded over RF (#63, #137) with a lamp confirmed by
current-sense feedback (#138). The spec already carries the corrected
``RF · auto · lit = confirmed``; this generator draws that verbatim and emits no
per-control prose comments, so the word "relay" appears NOWHERE in the output.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

import validate_panel_spec as _validator

HERE = Path(__file__).resolve().parent
DEFAULT_SPEC = HERE.parent / "panel-spec.yaml"
DEFAULT_SCHEMA = HERE.parent / "panel-spec.schema.json"
DEFAULT_OUTPUT = HERE.parent.parent / "docs" / "hardware" / "panel-mockup.svg"


class GeneratorError(Exception):
    """Raised when the spec cannot be turned into an SVG (e.g. unknown type)."""


# ---------------------------------------------------------------------------
# Deterministic float formatting
# ---------------------------------------------------------------------------
def _fmt(value: float | int) -> str:
    """Format a length for SVG output: fixed 3 dp, trailing zeros stripped.

    This is the single source of numeric formatting so the output is stable and
    byte-identical regardless of whether a value arrives as ``62`` or ``62.0``.
    """
    text = f"{float(value):.3f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


# ---------------------------------------------------------------------------
# Cosmetic template constants (verbatim visual language from the hand-authored
# mockup). These carry NO control legend text — only gradients, styles, fake UI
# and decorative markings that have no spec field to source them from.
# ---------------------------------------------------------------------------
_SVG_SCALE = 4  # px-per-mm used for the rendered width/height attributes
_FRAME_MARGIN = 18  # mm of drawing margin around the panel outline
_FRAME_BOTTOM_EXTRA = 40  # extra mm below the panel for the bottom dimension row

_DEFS = """\
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a3f44"/>
      <stop offset="1" stop-color="#25292d"/>
    </linearGradient>
    <linearGradient id="knob" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6b7278"/>
      <stop offset="1" stop-color="#31363a"/>
    </linearGradient>
    <linearGradient id="wheel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7d858c"/>
      <stop offset="1" stop-color="#2b2f33"/>
    </linearGradient>
    <radialGradient id="estop" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#ff5a4d"/>
      <stop offset="1" stop-color="#a5140b"/>
    </radialGradient>
    <radialGradient id="btnG" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#5ce08a"/><stop offset="1" stop-color="#158a41"/>
    </radialGradient>
    <radialGradient id="btnY" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#ffdc63"/><stop offset="1" stop-color="#b98800"/>
    </radialGradient>
    <radialGradient id="btnR" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#ff7b70"/><stop offset="1" stop-color="#a51d14"/>
    </radialGradient>
    <radialGradient id="btnB" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#7fc9ff"/><stop offset="1" stop-color="#1667a8"/>
    </radialGradient>
    <radialGradient id="btnW" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#f2f5f7"/><stop offset="1" stop-color="#9aa4ac"/>
    </radialGradient>
    <linearGradient id="scr" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#12202b"/><stop offset="1" stop-color="#0a151d"/>
    </linearGradient>
  </defs>"""

_STYLE = """\
  <style>
    .lbl  { fill:#d7dde2; font-size:3.4px; letter-spacing:0.35px; text-anchor:middle; font-weight:600; }
    .sub  { fill:#8e979e; font-size:2.6px; text-anchor:middle; }
    .tick { stroke:#aeb6bc; stroke-width:0.4; }
    .dim  { stroke:#5aa9e6; stroke-width:0.35; fill:none; }
    .dimt { fill:#5aa9e6; font-size:3.6px; text-anchor:middle; font-weight:600; }
    .note { fill:#9aa3aa; font-size:3px; }
  </style>"""

# Cosmetic: the "STOP" moulded on the physical mushroom head. Not a spec legend.
_ESTOP_MUSHROOM_MARK = "STOP"
# Cosmetic: hazard clause appended to the E-stop spec sub_label. See the module
# docstring "E-stop legend decision" — option (b). The spec sub_label is drawn
# verbatim; this clause is additive decoration only.
_ESTOP_HAZARD_ANNOTATION = " · CUTS SPINDLE + STEPPERS"

# Cosmetic: the fake DRO / soft-button mock-up drawn inside the DSI screen. This
# is illustrative UI, NOT a spec legend, and is positioned relative to the screen
# bezel top-left so it travels with the screen control. Placeholders are filled
# from the screen bezel origin.
_SCREEN_FAKE_UI = """\
    <rect x="{h0x}" y="{h0y}" width="154" height="10" fill="#16242f"/>
    <text x="{tx}" y="{ty0}" fill="#cfe4f2" font-size="4">bracket_v3.nc</text>
    <circle cx="{dotx}" cy="{doty}" r="2.2" fill="#35d07f"/>
    <text x="{rdyx}" y="{ty0}" fill="#35d07f" font-size="4" font-weight="700">READY</text>
    <text x="{labx}" y="{dy0}"  fill="#7f8f9b" font-size="4.6" font-weight="700">X</text>
    <text x="{valx}" y="{dy0}" fill="#eaf4fb" font-size="7.6" font-weight="700" text-anchor="end" font-family="Menlo, monospace">-142.507</text>
    <text x="{labx}" y="{dy1}"  fill="#7f8f9b" font-size="4.6" font-weight="700">Y</text>
    <text x="{valx}" y="{dy1}" fill="#eaf4fb" font-size="7.6" font-weight="700" text-anchor="end" font-family="Menlo, monospace">  88.240</text>
    <text x="{labx}" y="{dy2}"  fill="#7f8f9b" font-size="4.6" font-weight="700">Z</text>
    <text x="{valx}" y="{dy2}" fill="#ffcf5a" font-size="7.6" font-weight="700" text-anchor="end" font-family="Menlo, monospace">  -3.015</text>
    <line x1="{sepx}" y1="{sep0}" x2="{sepx}" y2="{sep1}" stroke="#263a49" stroke-width="0.5"/>
    <text x="{mlx}" y="{m0}" fill="#7f8f9b" font-size="3.2">FEED</text>
    <text x="{mrx}" y="{m0}" fill="#eaf4fb" font-size="4.6" text-anchor="end" font-family="Menlo, monospace">1200</text>
    <text x="{mlx}" y="{m1}" fill="#7f8f9b" font-size="3.2">SPINDLE</text>
    <text x="{mrx}" y="{m1}" fill="#eaf4fb" font-size="4.6" text-anchor="end" font-family="Menlo, monospace">18000</text>
    <text x="{mlx}" y="{m2}" fill="#7f8f9b" font-size="3.2">OVERRIDE</text>
    <text x="{mrx}" y="{m2}" fill="#35d07f" font-size="4.6" text-anchor="end" font-family="Menlo, monospace">100%</text>
    <text x="{mlx}" y="{m3}" fill="#7f8f9b" font-size="3.2">TOOL</text>
    <text x="{mrx}" y="{m3}" fill="#eaf4fb" font-size="4.6" text-anchor="end" font-family="Menlo, monospace">#302</text>
    <rect x="{pbx}" y="{pby}" width="146" height="5" rx="2.5" fill="#1d2c38"/>
    <rect x="{pbx}" y="{pby}" width="94"  height="5" rx="2.5" fill="#35d07f"/>
    <text x="{pbx}" y="{ptxt}" fill="#8fa3b2" font-size="3.2">64%  ·  12:41 elapsed  ·  ~7:02 remaining</text>
    <rect x="{sb0}"  y="{sby}" width="34" height="11" rx="2" fill="#20313e" stroke="#345266" stroke-width="0.5"/>
    <text x="{sb0t}" y="{sbty}" fill="#cfe4f2" font-size="3.8" text-anchor="middle">JOG</text>
    <rect x="{sb1}"  y="{sby}" width="34" height="11" rx="2" fill="#20313e" stroke="#345266" stroke-width="0.5"/>
    <text x="{sb1t}" y="{sbty}" fill="#cfe4f2" font-size="3.8" text-anchor="middle">PROBE</text>
    <rect x="{sb2}"  y="{sby}" width="34" height="11" rx="2" fill="#20313e" stroke="#345266" stroke-width="0.5"/>
    <text x="{sb2t}" y="{sbty}" fill="#cfe4f2" font-size="3.8" text-anchor="middle">FILES</text>
    <rect x="{sb3}" y="{sby}" width="35" height="11" rx="2" fill="#20313e" stroke="#345266" stroke-width="0.5"/>
    <text x="{sb3t}" y="{sbty}" fill="#cfe4f2" font-size="3.8" text-anchor="middle">SETUP</text>"""

# Cosmetic per-control decoration keyed by control id. These are NOT legends
# (colours, ring/graduation geometry, tick direction) — a wording change is a
# spec edit; this table only records the drawing's visual language. Graduation
# offsets are relative to the control CENTRE so they travel with the control.
_DECOR: dict[str, dict[str, Any]] = {
    # illuminated_button_22 / deadman lamp colours (gradient id + ring stroke).
    "start": {"fill": "btnG", "stroke": "#0c5427"},
    "hold": {"fill": "btnY", "stroke": "#7d5c00"},
    "reset": {"fill": "btnR", "stroke": "#6d130c"},
    "spindle": {"fill": "btnB", "stroke": "#0d4370"},
    "dust": {"fill": "btnW", "stroke": "#5e666d"},
    # led_indicator colours.
    "led_pwr": {"fill": "#35d07f"},
    "led_link": {"fill": "#35d07f"},
    "led_homed": {"fill": "#4aa3ff"},
    "led_alarm": {"fill": "#3a2f2f", "stroke": "#6b4a4a"},
    "led_probe": {"fill": "#3a3a2f", "stroke": "#6b664a"},
    # potentiometer / rotary_selector: scale-ring radius, tick vector, label
    # drop, and dial graduation glyphs (glyph, dx, dy[, fill]).
    "feed_override": {
        "ring_r": 21, "tick": (0, -13), "label_dy": 30,
        "grads": [("0", -21, 14), ("50", -17, -12), ("100", 0, -22),
                  ("150", 18, -12), ("200", 22, 14)],
    },
    "axis_select": {
        "ring_r": 21, "tick": (-12, -6), "label_dy": 30,
        "grads": [("OFF", -21, -6), ("X", -15, -19), ("Y", 0, -23), ("Z", 15, -19)],
    },
    "step_select": {
        "ring_r": 21, "tick": (0, -13), "label_dy": 30,
        "grads": [("×1", -19, -10), ("×10", 0, -23), ("×100", 20, -10),
                  ("0.001 / 0.01 / 0.1 mm", 0, 21, "#6f787e")],
    },
    "spindle_ovr": {
        "ring_r": 17, "tick": (0, -10), "label_dy": 22,
        "grads": [("50", -17, -8), ("100", 0, -19), ("150", 18, -8)],
    },
}

# Cosmetic bottom-row dimension callouts (decorative annotations, not legends).
_BOTTOM_DIMENSIONS = [
    (290, -2, "Ø40 mushroom / Ø22 mount"),
    (283, 300, "Ø76 · 100 PPR quadrature"),
    (120, 300, "Ø22 illuminated momentary ×5"),
]


# ---------------------------------------------------------------------------
# Small element helpers
# ---------------------------------------------------------------------------
def _lbl(cx: float, y: float, text: str) -> str:
    return f'<text class="lbl" x="{_fmt(cx)}" y="{_fmt(y)}">{text}</text>'


def _sub(cx: float, y: float, text: str) -> str:
    return f'<text class="sub" x="{_fmt(cx)}" y="{_fmt(y)}">{text}</text>'


# ---------------------------------------------------------------------------
# Per-type drawing routines. Each returns a list of SVG element lines (already
# indented for placement inside a control <g>). Legends come from ``control``;
# cosmetic geometry from :data:`_DECOR`.
# ---------------------------------------------------------------------------
def _draw_estop(control: dict, decor: dict) -> list[str]:
    cx, cy = float(control["x"]), float(control["y"])
    head_r = float(control.get("body_diameter", control["cutout"]["diameter"])) / 2.0
    plate = control["plate"]
    px, py = float(plate["x"]), float(plate["y"])
    pw, ph = float(plate["w"]), float(plate["h"])
    pr = float(plate.get("corner_r", 0))
    plate_cx = px + pw / 2.0
    sub_text = f"{control['sub_label']}{_ESTOP_HAZARD_ANNOTATION}"
    return [
        f'<rect x="{_fmt(px)}" y="{_fmt(py)}" width="{_fmt(pw)}" height="{_fmt(ph)}" '
        f'rx="{_fmt(pr)}" fill="#e8c11c" stroke="#8d7400" stroke-width="0.8"/>',
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="{_fmt(head_r + 5)}" fill="#2b2f33" opacity="0.25"/>',
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="{_fmt(head_r)}" fill="url(#estop)" stroke="#6d0d06" stroke-width="1"/>',
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="{_fmt(head_r - 7)}" fill="none" stroke="#7d1109" stroke-width="0.6" opacity="0.7"/>',
        f'<text x="{_fmt(cx)}" y="{_fmt(cy + 2)}" fill="#ffe9e6" font-size="5" font-weight="700" text-anchor="middle">{_ESTOP_MUSHROOM_MARK}</text>',
        f'<text x="{_fmt(plate_cx)}" y="{_fmt(py + ph - 8)}" fill="#4a3d00" font-size="4.6" font-weight="700" text-anchor="middle">{control["label"]}</text>',
        f'<text x="{_fmt(plate_cx)}" y="{_fmt(py + ph - 2.5)}" fill="#6a5800" font-size="3" text-anchor="middle">{sub_text}</text>',
    ]


def _draw_illuminated_button(control: dict, decor: dict) -> list[str]:
    cx, cy = float(control["x"]), float(control["y"])
    fill = decor.get("fill", "btnW")
    stroke = decor.get("stroke", "#5e666d")
    lines = [
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="11" fill="url(#{fill})" stroke="{stroke}" stroke-width="0.9"/>',
        _lbl(cx, cy + 18, control["label"]),
    ]
    if control.get("sub_label"):
        lines.append(_sub(cx, cy + 22.5, control["sub_label"]))
    return lines


def _draw_deadman(control: dict, decor: dict) -> list[str]:
    cx, cy = float(control["x"]), float(control["y"])
    outer_r = float(control.get("body_diameter", control["cutout"]["diameter"])) / 2.0
    lines = [
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="{_fmt(outer_r)}" fill="#3f464c" stroke="#20252a" stroke-width="1"/>',
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="8" fill="#2b3136" stroke="#585f65" stroke-width="0.5"/>',
        _lbl(cx, cy + 18, control["label"]),
    ]
    if control.get("sub_label"):
        lines.append(_sub(cx, cy + 22.5, control["sub_label"]))
    return lines


def _draw_knob(control: dict, decor: dict) -> list[str]:
    """Shared routine for potentiometer and rotary_selector controls."""
    cx, cy = float(control["x"]), float(control["y"])
    knob_r = float(control.get("body_diameter", control["cutout"]["diameter"])) / 2.0
    ring_r = float(decor.get("ring_r", knob_r + 6))
    tick_dx, tick_dy = decor.get("tick", (0, -(knob_r - 2)))
    label_dy = float(decor.get("label_dy", knob_r + 15))
    lines = [
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="{_fmt(ring_r)}" fill="none" stroke="#565d63" stroke-width="0.5"/>',
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="{_fmt(knob_r)}" fill="url(#knob)" stroke="#1e2226" stroke-width="0.9"/>',
        f'<line x1="{_fmt(cx)}" y1="{_fmt(cy)}" x2="{_fmt(cx + tick_dx)}" y2="{_fmt(cy + tick_dy)}" class="tick" stroke-width="1.2"/>',
    ]
    grads = decor.get("grads", [])
    if grads:
        lines.append('<g class="sub">')
        for grad in grads:
            glyph, gdx, gdy = grad[0], grad[1], grad[2]
            fill = f' fill="{grad[3]}"' if len(grad) > 3 else ""
            lines.append(
                f'  <text x="{_fmt(cx + gdx)}" y="{_fmt(cy + gdy)}"{fill}>{glyph}</text>'
            )
        lines.append("</g>")
    lines.append(_lbl(cx, cy + label_dy, control["label"]))
    return lines


def _draw_mpg(control: dict, decor: dict) -> list[str]:
    """MPG handwheel.

    The spec ``x``/``y`` is the RENDERED centre. The hand-authored drawing wraps
    the wheel group in ``translate(cx,cy) scale(0.94) translate(-283,-187)`` so
    that the drawn point (283,187) lands at the rendered centre. We reproduce
    that transform faithfully — only the outer translate is parameterised on the
    spec centre — so the wheel is neither moved nor re-scaled. The inner geometry
    is a fixed cosmetic block (knurl, dimple, rings) at its local coordinates.
    """
    cx, cy = float(control["x"]), float(control["y"])
    inner = """\
<g transform="translate({cx},{cy}) scale(0.94) translate(-283,-187)">
  <circle cx="283" cy="187" r="38" fill="#1e2226" opacity="0.5"/>
  <circle cx="283" cy="187" r="35" fill="url(#wheel)" stroke="#191d20" stroke-width="1.2"/>
  <circle cx="283" cy="187" r="26" fill="none" stroke="#20252a" stroke-width="0.8"/>
  <circle cx="283" cy="187" r="12" fill="#2b3136" stroke="#585f65" stroke-width="0.6"/>
  <g stroke="#20252a" stroke-width="0.55">
    <line x1="283" y1="152" x2="283" y2="161"/><line x1="283" y1="213" x2="283" y2="222"/>
    <line x1="248" y1="187" x2="257" y2="187"/><line x1="309" y1="187" x2="318" y2="187"/>
    <line x1="258" y1="162" x2="264" y2="168"/><line x1="302" y1="206" x2="308" y2="212"/>
    <line x1="308" y1="162" x2="302" y2="168"/><line x1="264" y1="206" x2="258" y2="212"/>
  </g>
  <circle cx="283" cy="163" r="4.6" fill="#12161a" stroke="#5c646a" stroke-width="0.5"/>
</g>""".format(cx=_fmt(cx), cy=_fmt(cy))
    lines = inner.split("\n")
    lines.append(_lbl(cx, cy + 41, control["label"]))
    return lines


def _draw_led(control: dict, decor: dict) -> list[str]:
    cx, cy = float(control["x"]), float(control["y"])
    fill = decor.get("fill", "#35d07f")
    stroke = decor.get("stroke")
    stroke_attr = f' stroke="{stroke}" stroke-width="0.4"' if stroke else ""
    # A status LED's printed legend is its spec ``label`` (drawn in the sub style).
    return [
        f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="3" fill="{fill}"{stroke_attr}/>',
        _sub(cx, cy + 8, control["label"]),
    ]


def _draw_port(control: dict, decor: dict) -> list[str]:
    """Shared routine for usb_passthrough and lan_passthrough couplers."""
    cx, cy = float(control["x"]), float(control["y"])
    cut = control["cutout"]
    w, h = float(cut["w"]), float(cut["h"])
    pr = float(cut.get("corner_r", 0))
    tlx, tly = cx - w / 2.0, cy - h / 2.0
    return [
        f'<rect x="{_fmt(tlx)}" y="{_fmt(tly)}" width="{_fmt(w)}" height="{_fmt(h)}" '
        f'rx="{_fmt(pr)}" fill="#12161a" stroke="#585f65" stroke-width="0.5"/>',
        _sub(cx, cy + 10.5, control["label"]),
    ]


def _draw_dsi_screen(control: dict, decor: dict) -> list[str]:
    """7" DSI touchscreen: bezel + active area + fake UI, plus a spec-sourced caption.

    The bezel top-left is derived from the spec centre and the module envelope
    (centre minus half the envelope), so the whole screen travels with the
    control. The fake DRO UI is cosmetic and offset from that origin. The
    original drawing had no printed legend for the screen; to keep every spec
    ``label``/``sub_label`` present in the output AND sourced from the spec, the
    screen's ``label``/``sub_label`` are drawn as the top caption that the
    hand-authored drawing already reserved for the DSI description.
    """
    cx, cy = float(control["x"]), float(control["y"])
    cut = control["cutout"]
    env = cut["module_envelope"]
    env_w, env_h = float(env["w"]), float(env["h"])
    active = cut["active_area"]
    act_w, act_h = float(active["w"]), float(active["h"])
    ox, oy = cx - env_w / 2.0, cy - env_h / 2.0  # bezel top-left

    # Bezel is drawn a hair larger than the module envelope (cosmetic border).
    bezel_w, bezel_h = env_w + 3, env_h + 4
    scr_x, scr_y = ox + 7, oy + 7  # active-area top-left offset within the bezel

    lines = [
        f'<rect x="{_fmt(ox)}" y="{_fmt(oy)}" width="{_fmt(bezel_w)}" height="{_fmt(bezel_h)}" '
        f'rx="2.5" fill="#0d1114" stroke="#585f65" stroke-width="0.6"/>',
        f'<rect x="{_fmt(scr_x)}" y="{_fmt(scr_y)}" width="{_fmt(act_w)}" height="{_fmt(act_h)}" fill="url(#scr)"/>',
    ]
    fake = _SCREEN_FAKE_UI.format(
        h0x=_fmt(scr_x), h0y=_fmt(scr_y),
        tx=_fmt(ox + 10.5), ty0=_fmt(oy + 14),
        dotx=_fmt(ox + 133), doty=_fmt(oy + 12),
        rdyx=_fmt(ox + 138),
        labx=_fmt(ox + 11), valx=_fmt(ox + 92),
        dy0=_fmt(oy + 29), dy1=_fmt(oy + 41), dy2=_fmt(oy + 53),
        sepx=_fmt(ox + 98), sep0=_fmt(oy + 21), sep1=_fmt(oy + 58),
        mlx=_fmt(ox + 103), mrx=_fmt(ox + 157),
        m0=_fmt(oy + 27), m1=_fmt(oy + 37), m2=_fmt(oy + 47), m3=_fmt(oy + 57),
        pbx=_fmt(ox + 11), pby=_fmt(oy + 63), ptxt=_fmt(oy + 74),
        sby=_fmt(oy + 79), sbty=_fmt(oy + 86.5),
        sb0=_fmt(ox + 11), sb0t=_fmt(ox + 28),
        sb1=_fmt(ox + 48), sb1t=_fmt(ox + 65),
        sb2=_fmt(ox + 85), sb2t=_fmt(ox + 102),
        sb3=_fmt(ox + 122), sb3t=_fmt(ox + 139.5),
    )
    lines.extend(fake.split("\n"))
    caption = f"{control['label']} · {control['sub_label']}"
    lines.append(
        f'<text class="dimt" x="{_fmt(cx)}" y="-2" font-size="3.2">{caption}</text>'
    )
    return lines


_DISPATCH: dict[str, Callable[[dict, dict], list[str]]] = {
    "estop_mushroom": _draw_estop,
    "illuminated_button_22": _draw_illuminated_button,
    "deadman_22": _draw_deadman,
    "potentiometer": _draw_knob,
    "rotary_selector": _draw_knob,
    "mpg_handwheel": _draw_mpg,
    "led_indicator": _draw_led,
    "dsi_screen": _draw_dsi_screen,
    "usb_passthrough": _draw_port,
    "lan_passthrough": _draw_port,
}


# ---------------------------------------------------------------------------
# Static (spec-derived, non-control) scaffolding
# ---------------------------------------------------------------------------
def _draw_panel_body(spec: dict) -> list[str]:
    panel = spec["panel"]
    w, h = float(panel["width"]), float(panel["height"])
    rx = float(panel.get("corner_radius", 0))
    lines = [
        "  <!-- ============ PANEL BODY ============ -->",
        f'  <rect x="0" y="0" width="{_fmt(w)}" height="{_fmt(h)}" rx="{_fmt(rx)}" '
        f'fill="url(#panel)" stroke="#14181b" stroke-width="1.2"/>',
        f'  <rect x="3" y="3" width="{_fmt(w - 6)}" height="{_fmt(h - 6)}" rx="5" '
        f'fill="none" stroke="#4c5359" stroke-width="0.5"/>',
        '  <g fill="#1b1f22" stroke="#585f65" stroke-width="0.4">',
    ]
    for hole in sorted(panel.get("mounting_holes", []), key=lambda mh: mh["id"]):
        hx, hy = _fmt(hole["x"]), _fmt(hole["y"])
        lines.append(f'    <circle cx="{hx}" cy="{hy}" r="2"/>')
    lines.append("  </g>")
    return lines


def _draw_zone_dividers(spec: dict) -> list[str]:
    w = float(spec["panel"]["width"])
    x2 = _fmt(w - 12)
    return [
        "  <!-- ============ ZONE DIVIDERS ============ -->",
        f'  <line x1="12" y1="156" x2="{x2}" y2="156" stroke="#4c5359" stroke-width="0.6"/>',
        '  <text x="12" y="153" class="note" font-size="2.8">— JOG / PENDANT —</text>',
        f'  <line x1="12" y1="238" x2="{x2}" y2="238" stroke="#4c5359" stroke-width="0.6"/>',
        '  <text x="12" y="235" class="note" font-size="2.8">— MACHINE / AUX —</text>',
    ]


def _draw_dimensions(spec: dict) -> list[str]:
    panel = spec["panel"]
    w, h = float(panel["width"]), float(panel["height"])
    lines = [
        "  <!-- ============ DIMENSIONS ============ -->",
        '  <g class="dim">',
        f'    <line x1="0" y1="-8" x2="{_fmt(w)}" y2="-8"/>',
        f'    <line x1="0" y1="-11" x2="0" y2="-5"/><line x1="{_fmt(w)}" y1="-11" x2="{_fmt(w)}" y2="-5"/>',
        f'    <line x1="-8" y1="0" x2="-8" y2="{_fmt(h)}"/>',
        f'    <line x1="-11" y1="0" x2="-5" y2="0"/><line x1="-11" y1="{_fmt(h)}" x2="-5" y2="{_fmt(h)}"/>',
        "  </g>",
        f'  <text class="dimt" x="{_fmt(w / 2)}" y="-10">{_fmt(w)} mm</text>',
        f'  <text class="dimt" x="-8" y="{_fmt(h / 2)}" transform="rotate(-90,-8,{_fmt(h / 2)})">{_fmt(h)} mm</text>',
    ]
    for dx, dy, text in _BOTTOM_DIMENSIONS:
        lines.append(f'  <text class="dimt" x="{_fmt(dx)}" y="{_fmt(dy)}" font-size="3.2">{text}</text>')
    return lines


def _draw_control(control: dict) -> list[str]:
    ctype = control["type"]
    routine = _DISPATCH.get(ctype)
    if routine is None:
        raise GeneratorError(
            f"control '{control.get('id', '<unknown>')}' has no drawing routine "
            f"for type {ctype!r}; known types are: {', '.join(sorted(_DISPATCH))}"
        )
    decor = _DECOR.get(control["id"], {})
    body = routine(control, decor)
    out = [f'  <!-- control: {control["id"]} ({ctype}) -->', "  <g>"]
    out.extend(f"    {line}" for line in body)
    out.append("  </g>")
    return out


# ---------------------------------------------------------------------------
# Top-level generation
# ---------------------------------------------------------------------------
def generate_svg(spec: dict) -> str:
    """Pure function: parsed spec -> deterministic SVG string.

    Controls are emitted sorted by ``id``; every numeric goes through
    :func:`_fmt`. Raises :class:`GeneratorError` on an unknown control type.
    """
    panel = spec["panel"]
    w, h = float(panel["width"]), float(panel["height"])
    vb_w = w + 2 * _FRAME_MARGIN
    vb_h = h + _FRAME_MARGIN + _FRAME_BOTTOM_EXTRA
    px_w = _fmt(vb_w * _SVG_SCALE)
    px_h = _fmt(vb_h * _SVG_SCALE)

    lines: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{_fmt(-_FRAME_MARGIN)} {_fmt(-_FRAME_MARGIN)} {_fmt(vb_w)} {_fmt(vb_h)}" '
        f'width="{px_w}" height="{px_h}" '
        f'font-family="Helvetica Neue, Helvetica, Arial, sans-serif">',
        _DEFS,
        _STYLE,
        "",
    ]
    lines.extend(_draw_panel_body(spec))
    lines.append("")
    lines.extend(_draw_zone_dividers(spec))
    lines.append("")

    for control in sorted(spec.get("controls", []), key=lambda c: c["id"]):
        lines.extend(_draw_control(control))
        lines.append("")

    lines.extend(_draw_dimensions(spec))
    lines.append("</svg>")
    return "\n".join(lines) + "\n"


def load_and_generate(spec_path: Path, schema_path: Path) -> str:
    """Validate then generate. Raises on invalid spec (no output produced)."""
    schema = _validator.load_schema(schema_path)
    spec = _validator.load_yaml(spec_path)
    if not isinstance(spec, dict):
        raise GeneratorError(f"spec root must be a mapping, got {type(spec).__name__}")
    errors = _validator.run_validation(spec, schema)
    if errors:
        raise GeneratorError(
            "refusing to generate from an invalid spec; "
            f"{len(errors)} problem(s):\n  - " + "\n  - ".join(errors)
        )
    return generate_svg(spec)


def _atomic_write(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically via a temp file in the same dir.

    The temp file lives beside the target (never a system temp dir) so the
    rename is atomic and a failure mid-write cannot corrupt the committed file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate docs/hardware/panel-mockup.svg from the panel spec."
    )
    parser.add_argument("--spec", default=str(DEFAULT_SPEC), help="path to panel-spec.yaml")
    parser.add_argument("--schema", default=str(DEFAULT_SCHEMA), help="path to panel-spec.schema.json")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="path to write the SVG")
    parser.add_argument(
        "--stdout", action="store_true",
        help="write the SVG to stdout instead of --output (still validates first)",
    )
    args = parser.parse_args(argv)

    try:
        svg = load_and_generate(Path(args.spec), Path(args.schema))
    except (_validator.SpecError, GeneratorError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.stdout:
        sys.stdout.write(svg)
    else:
        _atomic_write(Path(args.output), svg)
        print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
