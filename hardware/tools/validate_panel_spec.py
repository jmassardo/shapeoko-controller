#!/usr/bin/env python3
"""Validate the canonical Shapeoko panel spec.

Pipeline (all failures are collected and reported, not just the first):
  1. YAML load        — malformed YAML fails with the parse location.
  2. Schema validation — structure / types / closed control-type enum.
  3. Geometry          — cutout overlap, panel-outline containment, minimum web,
                         and PHYSICAL BODY interference (body-to-body, body-to-
                         cutout, body containment, body-to-label-zone).
  4. Safety distances  — the load-bearing rules fixed in issue #115.

Cutout rules and body rules are deliberately BOTH enforced and are not the same
rule expressed twice:
  * `min_web` is a MATERIAL-STRENGTH rule. It is about how much panel stock is
    left standing between two holes, so it applies to cutouts only.
  * The body rules are INTERFERENCE rules. They are about components fouling one
    another, fouling a neighbouring hole, or covering a neighbour's printed
    legend. Two bodies may legally sit closer together than `min_web`; they
    simply may not intersect.

Exit code 0 and a control count are printed only when the spec is fully valid.
Any failure exits non-zero and no "valid" summary is emitted.

This validator is deliberately isolated in hardware/ with its own pyproject.toml
(pyyaml + jsonschema) and is NOT coupled to the Node workspaces.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft7Validator

# ---------------------------------------------------------------------------
# Safety-distance rules — FIXED IN ISSUE #115. Do not relax these to make a
# spec edit pass. If a real coordinate violates one of these, that is a design
# finding to escalate, not a constant to lower.
# ---------------------------------------------------------------------------
SAFETY_MIN_ENABLE_TO_MPG_MM = 250.0  # deadman must not be within reach of the handwheel (#115)
SAFETY_MIN_RESET_TO_ESTOP_MM = 75.0  # RESET must not be mistaken for the E-stop (#115)

ENABLE_ID = "enable"
MPG_ID = "mpg"
RESET_ID = "reset"
ESTOP_ID = "estop"

HERE = Path(__file__).resolve().parent
DEFAULT_SPEC = HERE.parent / "panel-spec.yaml"
DEFAULT_SCHEMA = HERE.parent / "panel-spec.schema.json"


class SpecError(Exception):
    """A fatal error that prevents any further validation (bad YAML / IO)."""


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def load_yaml(path: Path) -> Any:
    """Load YAML, raising SpecError with the parse location on malformed input."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:  # pragma: no cover - IO edge
        raise SpecError(f"cannot read spec file {path}: {exc}") from exc
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        if mark is not None:
            where = f"line {mark.line + 1} column {mark.column + 1}"
        else:
            where = "unknown location"
        raise SpecError(f"malformed YAML in {path} at {where}: {exc}") from exc


def load_schema(path: Path) -> dict:
    import json

    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------
def validate_schema(spec: Any, schema: dict) -> list[str]:
    """Return a list of human-readable schema errors (empty == valid)."""
    validator = Draft7Validator(schema)
    errors: list[str] = []
    for err in sorted(validator.iter_errors(spec), key=lambda e: list(e.absolute_path)):
        loc = "/".join(str(p) for p in err.absolute_path) or "<root>"
        msg = f"schema: {loc}: {err.message}"
        # Make the closed control-type enum failure explicitly list the legal
        # types and the offending id (edge case in the issue's test plan).
        if err.validator == "enum" and err.absolute_path and err.absolute_path[-1] == "type":
            offending = _control_id_from_path(spec, err.absolute_path)
            legal = ", ".join(err.validator_value)
            msg = (
                f"schema: control '{offending}': unknown type "
                f"{err.instance!r}; legal types are: {legal}"
            )
        errors.append(msg)
    return errors


def _control_id_from_path(spec: Any, path) -> str:
    try:
        parts = list(path)
        idx = parts[parts.index("controls") + 1]
        return spec["controls"][idx].get("id", f"<index {idx}>")
    except (ValueError, IndexError, KeyError, TypeError):
        return "<unknown>"


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------
def cutout_bbox(control: dict) -> tuple[float, float, float, float]:
    """Axis-aligned bounding box (xmin, ymin, xmax, ymax) of a control cutout.

    For the DSI screen the *module envelope* is used, since that is the largest
    footprint that must be kept clear of neighbouring cutouts.
    """
    cx, cy = float(control["x"]), float(control["y"])
    cut = control["cutout"]
    if cut["kind"] == "round":
        r = float(cut["diameter"]) / 2.0
        return (cx - r, cy - r, cx + r, cy + r)
    # rect
    env = cut.get("module_envelope")
    w = float(env["w"]) if env else float(cut["w"])
    h = float(env["h"]) if env else float(cut["h"])
    return (cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0)


def body_bbox(control: dict) -> tuple[float, float, float, float]:
    """Axis-aligned bounding box of a control's PHYSICAL BODY envelope.

    The body is what the operator's hand actually meets: the mushroom head, the
    knob skirt, the handwheel rim. It is regularly LARGER than the cutout it
    mounts through (the MPG is a Ø76 wheel on a Ø50 boss recess — it overhangs
    the panel by 13 mm all round), so validating cutouts alone silently misses
    real interference. See issue #116 review.

    For round cutouts the envelope is `body_diameter`, defaulting to the cutout
    diameter when absent (correct for flush or near-flush components). For rect
    cutouts there is no separate body dimension, so the cutout box is used.
    """
    cut = control["cutout"]
    if cut["kind"] != "round":
        return cutout_bbox(control)
    cx, cy = float(control["x"]), float(control["y"])
    r = float(control.get("body_diameter", cut["diameter"])) / 2.0
    return (cx - r, cy - r, cx + r, cy + r)


def label_zone_bbox(control: dict) -> tuple[float, float, float, float] | None:
    """AABB of a control's reserved legend area, or None if it declares no zone.

    Expressed TOP-LEFT origin (x, y, w, h) in the spec, matching the E-stop
    `plate` convention, because a legend is an area rather than a centre.
    """
    zone = control.get("label_zone")
    if not zone:
        return None
    x0, y0 = float(zone["x"]), float(zone["y"])
    return (x0, y0, x0 + float(zone["w"]), y0 + float(zone["h"]))


def bbox_overlap(a: tuple, b: tuple) -> tuple[float, float] | None:
    """Overlap depth (dx, dy) of two AABBs, or None when they do not intersect.

    Touching exactly (zero-width intersection) is NOT an overlap — components
    may sit shoulder to shoulder.
    """
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    dx = min(ax1, bx1) - max(ax0, bx0)
    dy = min(ay1, by1) - max(ay0, by0)
    if dx <= 0 or dy <= 0:
        return None
    return (dx, dy)


def bbox_gap(a: tuple, b: tuple) -> float:
    """Edge-to-edge gap between two AABBs. Negative == overlap by that amount."""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    dx = max(bx0 - ax1, ax0 - bx1)  # >0 if separated on x
    dy = max(by0 - ay1, ay0 - by1)  # >0 if separated on y
    if dx > 0 and dy > 0:
        return math.hypot(dx, dy)
    # Overlapping on at least one axis: the gap is the (possibly negative) max.
    return max(dx, dy)


# ---------------------------------------------------------------------------
# Geometry validation
# ---------------------------------------------------------------------------
def validate_geometry(spec: dict) -> list[str]:
    errors: list[str] = []
    panel = spec["panel"]
    width = float(panel["width"])
    height = float(panel["height"])
    min_web = float(panel["min_web"])
    controls = spec["controls"]

    boxes = {c["id"]: cutout_bbox(c) for c in controls}

    # Containment: every cutout must lie fully inside the panel outline.
    for c in controls:
        x0, y0, x1, y1 = boxes[c["id"]]
        if x0 < 0 or y0 < 0 or x1 > width or y1 > height:
            errors.append(
                f"geometry: control '{c['id']}' cutout crosses the panel outline "
                f"(bbox=({x0:.2f},{y0:.2f},{x1:.2f},{y1:.2f}), panel={width}x{height})"
            )

    # Pairwise overlap / minimum web between control cutouts.
    ids = [c["id"] for c in controls]
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            gap = bbox_gap(boxes[a], boxes[b])
            if gap < 0:
                errors.append(
                    f"geometry: control cutouts '{a}' and '{b}' overlap "
                    f"(by {-gap:.2f} mm)"
                )
            elif gap < min_web:
                errors.append(
                    f"geometry: control cutouts '{a}' and '{b}' violate the minimum "
                    f"web ({gap:.2f} mm < {min_web} mm required)"
                )

    errors.extend(validate_bodies(spec))
    return errors


# ---------------------------------------------------------------------------
# Physical body (interference) validation — issue #116 review
# ---------------------------------------------------------------------------
def validate_bodies(spec: dict) -> list[str]:
    """Validate PHYSICAL BODY envelopes, not just the holes they mount through.

    Four independent rules, all collected (never raised early):
      * body-to-body      — no two component bodies may intersect.
      * body-to-cutout    — a body may not overhang a DIFFERENT control's cutout.
      * body containment  — every body must lie fully inside the panel outline.
      * body-to-label     — a body may not intrude on another control's legend.

    `min_web` is deliberately NOT applied here: it is a material-strength rule
    about stock left between holes. Bodies may sit closer than the web; they
    just may not touch.
    """
    errors: list[str] = []
    panel = spec["panel"]
    width = float(panel["width"])
    height = float(panel["height"])
    controls = spec["controls"]

    bodies = {c["id"]: body_bbox(c) for c in controls}
    cutouts = {c["id"]: cutout_bbox(c) for c in controls}
    zones = {c["id"]: z for c in controls if (z := label_zone_bbox(c)) is not None}

    # A body smaller than its own cutout is a transcription error: it would
    # silently under-report every rule below.
    for c in controls:
        cut = c["cutout"]
        if cut["kind"] != "round" or "body_diameter" not in c:
            continue
        body_d, cut_d = float(c["body_diameter"]), float(cut["diameter"])
        if body_d < cut_d:
            errors.append(
                f"geometry: control '{c['id']}' body_diameter {body_d:.2f} mm is smaller "
                f"than its cutout diameter {cut_d:.2f} mm (by {cut_d - body_d:.2f} mm); "
                f"a component body cannot be smaller than the hole it mounts in"
            )

    # Containment: every body envelope must lie fully inside the panel outline.
    for c in controls:
        cid = c["id"]
        x0, y0, x1, y1 = bodies[cid]
        if x0 < 0 or y0 < 0 or x1 > width or y1 > height:
            over = max(-x0, -y0, x1 - width, y1 - height)
            errors.append(
                f"geometry: control '{cid}' body envelope crosses the panel outline "
                f"(by {over:.2f} mm; bbox=({x0:.2f},{y0:.2f},{x1:.2f},{y1:.2f}), "
                f"panel={width}x{height})"
            )

    ids = [c["id"] for c in controls]

    # Body-to-body: two components physically fouling one another.
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            hit = bbox_overlap(bodies[a], bodies[b])
            if hit:
                errors.append(
                    f"geometry: control bodies '{a}' and '{b}' overlap "
                    f"(by {hit[0]:.2f} mm in x, {hit[1]:.2f} mm in y)"
                )

    # Body-to-cutout: a body overhanging a DIFFERENT control's hole.
    for a in ids:
        for b in ids:
            if a == b:
                continue
            hit = bbox_overlap(bodies[a], cutouts[b])
            if hit:
                errors.append(
                    f"geometry: control body '{a}' overhangs the cutout of '{b}' "
                    f"(by {hit[0]:.2f} mm in x, {hit[1]:.2f} mm in y)"
                )

    # Body-to-label-zone: a body sitting on top of a neighbour's printed legend.
    # This is the rule that catches the #116 defect directly: at the pre-
    # transform MPG centre the Ø76 wheel covered RESET's sub-label.
    for a in ids:
        for b, zone in zones.items():
            if a == b:
                continue
            hit = bbox_overlap(bodies[a], zone)
            if hit:
                errors.append(
                    f"geometry: control body '{a}' intrudes on the label_zone of '{b}' "
                    f"(by {hit[0]:.2f} mm in x, {hit[1]:.2f} mm in y)"
                )

    return errors


# ---------------------------------------------------------------------------
# Safety validation (#115)
# ---------------------------------------------------------------------------
def _by_id(spec: dict, control_id: str) -> dict | None:
    for c in spec["controls"]:
        if c["id"] == control_id:
            return c
    return None


def validate_safety(spec: dict) -> list[str]:
    errors: list[str] = []

    enable = _by_id(spec, ENABLE_ID)
    mpg = _by_id(spec, MPG_ID)
    reset = _by_id(spec, RESET_ID)
    estop = _by_id(spec, ESTOP_ID)

    # ENABLE deadman must stay clear of the MPG handwheel.
    if enable and mpg:
        d = math.dist((enable["x"], enable["y"]), (mpg["x"], mpg["y"]))
        if d < SAFETY_MIN_ENABLE_TO_MPG_MM:
            errors.append(
                f"safety(#115): ENABLE-to-MPG centre distance {d:.2f} mm is below the "
                f"required {SAFETY_MIN_ENABLE_TO_MPG_MM} mm"
            )
    else:
        errors.append("safety(#115): cannot evaluate ENABLE-to-MPG rule; missing control(s)")

    # RESET must be outside the E-stop yellow plate and clear of the mushroom.
    if reset and estop:
        plate = estop.get("plate")
        if plate:
            px0, py0 = float(plate["x"]), float(plate["y"])
            px1, py1 = px0 + float(plate["w"]), py0 + float(plate["h"])
            if px0 <= reset["x"] <= px1 and py0 <= reset["y"] <= py1:
                errors.append(
                    f"safety(#115): RESET centre ({reset['x']},{reset['y']}) lies inside the "
                    f"E-stop plate bounds x[{px0},{px1}] y[{py0},{py1}]"
                )
        else:
            errors.append("safety(#115): E-stop is missing its plate sub-object")
        d = math.dist((reset["x"], reset["y"]), (estop["x"], estop["y"]))
        if d < SAFETY_MIN_RESET_TO_ESTOP_MM:
            errors.append(
                f"safety(#115): RESET-to-E-stop centre distance {d:.2f} mm is below the "
                f"required {SAFETY_MIN_RESET_TO_ESTOP_MM} mm"
            )
    else:
        errors.append("safety(#115): cannot evaluate RESET-to-E-stop rule; missing control(s)")

    # The E-stop must be flagged safety_critical.
    if estop is not None and not estop.get("safety_critical", False):
        errors.append("safety(#115): E-stop must be flagged safety_critical: true")

    return errors


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def run_validation(spec: Any, schema: dict) -> list[str]:
    """Validate a loaded spec. Returns a list of all errors (empty == valid).

    Schema validation runs first; if the structure is invalid we do not attempt
    geometry/safety, whose code assumes required fields exist.
    """
    schema_errors = validate_schema(spec, schema)
    if schema_errors:
        return schema_errors
    errors: list[str] = []
    errors.extend(validate_geometry(spec))
    errors.extend(validate_safety(spec))
    return errors


def validate_file(spec_path: Path, schema_path: Path) -> tuple[list[str], int]:
    """Load and validate a spec file. Returns (errors, control_count).

    Raises SpecError on unloadable YAML (reported before any partial output).
    """
    schema = load_schema(schema_path)
    spec = load_yaml(spec_path)
    if not isinstance(spec, dict):
        raise SpecError(f"spec root must be a mapping, got {type(spec).__name__}")
    errors = run_validation(spec, schema)
    count = len(spec.get("controls", []) or [])
    return errors, count


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Validate the Shapeoko panel spec.")
    parser.add_argument("spec", nargs="?", default=str(DEFAULT_SPEC), help="path to panel-spec.yaml")
    parser.add_argument("--schema", default=str(DEFAULT_SCHEMA), help="path to panel-spec.schema.json")
    args = parser.parse_args(argv)

    try:
        errors, count = validate_file(Path(args.spec), Path(args.schema))
    except SpecError as exc:
        print(f"INVALID: {exc}", file=sys.stderr)
        return 2

    if errors:
        print(f"INVALID: {len(errors)} problem(s) found:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"VALID: panel spec OK, {count} controls.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
