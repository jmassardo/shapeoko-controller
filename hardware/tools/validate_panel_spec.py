#!/usr/bin/env python3
"""Validate the canonical Shapeoko panel spec.

Pipeline (all failures are collected and reported, not just the first):
  1. YAML load        — malformed YAML fails with the parse location.
  2. Schema validation — structure / types / closed control-type enum.
  3. Geometry          — cutout overlap, panel-outline containment, minimum web.
  4. Safety distances  — the load-bearing rules fixed in issue #115.

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
