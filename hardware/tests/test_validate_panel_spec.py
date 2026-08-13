"""Unit tests for the panel-spec validator.

These tests load the committed spec, then mutate *in-memory copies* to prove
each geometric and safety rule fires. The committed spec on disk is never
modified. Safety constants are never relaxed here — mutations move controls
into a violating position and assert the validator catches them.
"""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
import yaml

import validate_panel_spec as v
from validate_panel_spec import SpecError

HARDWARE = Path(__file__).resolve().parent.parent
SPEC_PATH = HARDWARE / "panel-spec.yaml"
SCHEMA_PATH = HARDWARE / "panel-spec.schema.json"

EXPECTED_CONTROL_COUNT = 20


@pytest.fixture(scope="module")
def schema() -> dict:
    return v.load_schema(SCHEMA_PATH)


@pytest.fixture
def spec() -> dict:
    return v.load_yaml(SPEC_PATH)


def _find(spec: dict, control_id: str) -> dict:
    for c in spec["controls"]:
        if c["id"] == control_id:
            return c
    raise AssertionError(f"control {control_id} not found")


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------
def test_committed_spec_is_valid(spec, schema):
    errors = v.run_validation(spec, schema)
    assert errors == [], errors


def test_committed_spec_control_count(spec):
    assert len(spec["controls"]) == EXPECTED_CONTROL_COUNT


def test_validate_file_exit_zero_and_count():
    errors, count = v.validate_file(SPEC_PATH, SCHEMA_PATH)
    assert errors == []
    assert count == EXPECTED_CONTROL_COUNT


def test_main_returns_zero(capsys):
    rc = v.main([str(SPEC_PATH), "--schema", str(SCHEMA_PATH)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "20 controls" in out
    assert "VALID" in out


# ---------------------------------------------------------------------------
# Panel outline / acceptance-criteria facts
# ---------------------------------------------------------------------------
def test_panel_outline_and_mounting_holes(spec):
    panel = spec["panel"]
    assert panel["units"] == "mm"
    assert panel["width"] == 340
    assert panel["height"] == 290
    assert panel["corner_radius"] == 7
    holes = {(h["x"], h["y"]) for h in panel["mounting_holes"]}
    assert holes == {(8, 8), (332, 8), (8, 282), (332, 282)}
    assert all(h["thread"] == "M4" for h in panel["mounting_holes"])


def test_every_control_has_required_geometry_fields(spec):
    for c in spec["controls"]:
        assert c["id"]
        assert c["type"]
        assert isinstance(c["x"], (int, float))
        assert isinstance(c["y"], (int, float))
        assert "kind" in c["cutout"]


# ---------------------------------------------------------------------------
# Labels / DUST correction / no relay
# ---------------------------------------------------------------------------
def test_dust_sub_label_is_corrected(spec):
    dust = _find(spec, "dust")
    assert dust["sub_label"] == "RF · auto · lit = confirmed"
    assert "relay" not in dust["sub_label"]


def test_spindle_sub_label(spec):
    assert _find(spec, "spindle")["sub_label"] == "M3/M5 · lit = running"


def test_dust_and_spindle_sub_labels_consistent_form(spec):
    # both state mechanism, then what illumination means ("lit = ...")
    for cid in ("dust", "spindle"):
        assert "lit =" in _find(spec, cid)["sub_label"]


def test_word_relay_appears_nowhere_in_spec_file():
    text = SPEC_PATH.read_text(encoding="utf-8")
    assert "relay" not in text.lower()


# ---------------------------------------------------------------------------
# Ø22 cutout is the bore + anti-rotation flat, not the bezel
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("cid", ["estop", "start", "hold", "reset", "spindle", "dust", "enable"])
def test_diameter22_controls_specify_bore_and_flat(spec, cid):
    cut = _find(spec, cid)["cutout"]
    assert cut["kind"] == "round"
    assert cut["diameter"] == 22.5
    assert cut["anti_rotation_flat"] > 0


# ---------------------------------------------------------------------------
# DSI screen distinguishes module / active / aperture
# ---------------------------------------------------------------------------
def test_dsi_screen_distinguishes_three_rectangles(spec):
    cut = _find(spec, "dsi_screen")["cutout"]
    assert cut["kind"] == "rect"
    # visible aperture (what is actually cut)
    assert (cut["w"], cut["h"]) == (156, 88)
    # module envelope and active area distinct from the aperture
    assert (cut["module_envelope"]["w"], cut["module_envelope"]["h"]) == (165, 100)
    assert (cut["active_area"]["w"], cut["active_area"]["h"]) == (154, 86)


# ---------------------------------------------------------------------------
# E-stop plate
# ---------------------------------------------------------------------------
def test_estop_flagged_and_has_plate(spec):
    estop = _find(spec, "estop")
    assert estop["safety_critical"] is True
    plate = estop["plate"]
    assert (plate["x"], plate["y"], plate["w"], plate["h"]) == (252, 12, 76, 76)


# ---------------------------------------------------------------------------
# Safety rules — each fires on a mutated in-memory copy
# ---------------------------------------------------------------------------
def test_enable_moved_within_reach_of_mpg_fails(spec):
    mpg = _find(spec, "mpg")
    enable = _find(spec, "enable")
    # Move ENABLE to 240 mm from the MPG (below the 250 mm rule).
    enable["x"] = mpg["x"] - 240
    enable["y"] = mpg["y"]
    errors = v.validate_safety(spec)
    assert any("ENABLE-to-MPG" in e for e in errors), errors


def test_reset_moved_onto_yellow_plate_fails(spec):
    estop = _find(spec, "estop")
    reset = _find(spec, "reset")
    # Move RESET onto the mushroom centre → inside plate AND too close.
    reset["x"], reset["y"] = estop["x"], estop["y"]
    errors = v.validate_safety(spec)
    assert any("inside the E-stop plate" in e for e in errors), errors
    assert any("RESET-to-E-stop" in e for e in errors), errors


def test_estop_not_flagged_fails_safety(spec):
    _find(spec, "estop")["safety_critical"] = False
    errors = v.validate_safety(spec)
    assert any("flagged safety_critical" in e for e in errors), errors


# ---------------------------------------------------------------------------
# Geometry rules
# ---------------------------------------------------------------------------
def test_overlapping_bores_fail(spec):
    hold = _find(spec, "hold")
    start = _find(spec, "start")
    # Slide HOLD on top of START.
    hold["x"], hold["y"] = start["x"], start["y"]
    errors = v.validate_geometry(spec)
    assert any("overlap" in e and "start" in e and "hold" in e for e in errors), errors


def test_control_pushed_past_edge_fails(spec):
    reset = _find(spec, "reset")
    reset["x"] = 340  # bore now crosses the 340 mm right edge
    errors = v.validate_geometry(spec)
    assert any("crosses the panel outline" in e and "reset" in e for e in errors), errors


def test_minimum_web_violation_fails(spec):
    # Bring HOLD to just under min_web from START without overlapping.
    start = _find(spec, "start")
    hold = _find(spec, "hold")
    min_web = spec["panel"]["min_web"]
    # centre distance = diameter + (min_web - 1) → gap = min_web - 1 < min_web
    hold["y"] = start["y"]
    hold["x"] = start["x"] + 22.5 + (min_web - 1)
    errors = v.validate_geometry(spec)
    assert any("minimum" in e and "start" in e and "hold" in e for e in errors), errors


def test_multiple_violations_all_reported(spec):
    # Overlap two bores AND move ENABLE within reach of the MPG at once.
    start = _find(spec, "start")
    hold = _find(spec, "hold")
    hold["x"], hold["y"] = start["x"], start["y"]
    mpg = _find(spec, "mpg")
    enable = _find(spec, "enable")
    enable["x"], enable["y"] = mpg["x"] - 240, mpg["y"]
    errors = v.run_validation(spec, v.load_schema(SCHEMA_PATH))
    assert any("overlap" in e for e in errors)
    assert any("ENABLE-to-MPG" in e for e in errors)
    assert len(errors) >= 2


# ---------------------------------------------------------------------------
# Schema edge / error cases
# ---------------------------------------------------------------------------
def test_unknown_control_type_lists_legal_types(spec, schema):
    _find(spec, "start")["type"] = "big_red_lever"
    errors = v.validate_schema(spec, schema)
    joined = "\n".join(errors)
    assert "start" in joined
    assert "big_red_lever" in joined
    assert "illuminated_button_22" in joined  # legal types listed


def test_missing_required_field_fails(spec, schema):
    del _find(spec, "start")["label"]
    errors = v.validate_schema(spec, schema)
    assert any("label" in e for e in errors), errors


def test_malformed_yaml_reports_location(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text("panel:\n  width: 340\n : : bad\n", encoding="utf-8")
    with pytest.raises(SpecError) as exc:
        v.load_yaml(bad)
    assert "malformed YAML" in str(exc.value)
    assert "line" in str(exc.value)


def test_malformed_yaml_does_not_emit_partial_spec(tmp_path, capsys):
    bad = tmp_path / "bad.yaml"
    bad.write_text("controls: [ {id: x, \n", encoding="utf-8")
    rc = v.main([str(bad), "--schema", str(SCHEMA_PATH)])
    captured = capsys.readouterr()
    assert rc == 2
    assert "VALID" not in captured.out
    assert "INVALID" in captured.err


def test_unknown_type_via_main_exits_nonzero(spec, tmp_path, capsys):
    _find(spec, "start")["type"] = "not_a_real_type"
    p = tmp_path / "spec.yaml"
    p.write_text(yaml.safe_dump(spec, allow_unicode=True), encoding="utf-8")
    rc = v.main([str(p), "--schema", str(SCHEMA_PATH)])
    err = capsys.readouterr().err
    assert rc == 1
    assert "not_a_real_type" in err


def test_dsi_module_envelope_within_panel(spec):
    # Regression: the DSI module footprint must be contained (it sits hard by
    # the top-left corner).
    errors = v.validate_geometry(spec)
    assert not any("dsi_screen" in e for e in errors), errors
