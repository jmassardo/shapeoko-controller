"""Unit tests for the panel-spec validator.

These tests load the committed spec, then mutate *in-memory copies* to prove
each geometric and safety rule fires. The committed spec on disk is never
modified. Safety constants are never relaxed here — mutations move controls
into a violating position and assert the validator catches them.
"""

from __future__ import annotations

import copy
import math
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


# ---------------------------------------------------------------------------
# Defect #116-a — MPG centre must be the RENDERED (post-transform) coordinate
# ---------------------------------------------------------------------------
def test_mpg_centre_is_the_post_transform_coordinate(spec):
    """Regression pin for the #116 review defect.

    docs/hardware/panel-mockup.svg wraps the MPG group in
        transform="translate(285,192) scale(0.94) translate(-283,-187)"
    so the RENDERED centre is (285,192). The pre-transform (283,187) was
    transcribed by mistake, reverting a deliberate layout fix that kept the
    Ø76 wheel off RESET's sub-label. Do not "restore" (283,187).
    """
    mpg = _find(spec, "mpg")
    assert (mpg["x"], mpg["y"]) == (285, 192)


def test_mpg_records_physical_body_not_the_scaled_drawing(spec):
    # scale(0.94) shrank the DRAWING only; the real handwheel is Ø76.
    assert _find(spec, "mpg")["body_diameter"] == 76
    assert _find(spec, "mpg")["cutout"]["diameter"] == 50.0


def test_mpg_fix_does_not_weaken_the_enable_distance_rule(spec):
    """The fix must IMPROVE, not erode, the #115 ENABLE↔MPG margin."""
    enable, mpg = _find(spec, "enable"), _find(spec, "mpg")
    d = math.dist((enable["x"], enable["y"]), (mpg["x"], mpg["y"]))
    assert d == pytest.approx(255.20, abs=0.01)          # sqrt(255² + 10²)
    assert d >= v.SAFETY_MIN_ENABLE_TO_MPG_MM
    assert d > math.dist((enable["x"], enable["y"]), (283, 187))  # was 253.05


def test_pre_transform_mpg_position_is_rejected_by_the_body_rules(spec):
    """The exact defect must now FAIL validation, not pass silently."""
    mpg = _find(spec, "mpg")
    mpg["x"], mpg["y"] = 283, 187
    errors = v.validate_geometry(spec)
    assert any("label_zone of 'reset'" in e and "'mpg'" in e for e in errors), errors
    # ...and it was invisible to the cutout and safety rules, which is the
    # systemic gap this defect exposed.
    assert v.validate_safety(spec) == []
    assert not any("cutouts" in e for e in errors), errors


def test_safety_constants_are_unchanged():
    assert v.SAFETY_MIN_ENABLE_TO_MPG_MM == 250.0
    assert v.SAFETY_MIN_RESET_TO_ESTOP_MM == 75.0


# ---------------------------------------------------------------------------
# Defect #116-b — body envelopes, not just cutouts
# ---------------------------------------------------------------------------
def _synthetic(*controls: dict, width: float = 340, height: float = 290) -> dict:
    """Minimal well-formed spec for exercising a single geometry rule."""
    return {
        "panel": {
            "units": "mm", "width": width, "height": height,
            "corner_radius": 7, "min_web": 6,
            "mounting_holes": [{"id": "mh", "x": 8, "y": 8, "diameter": 4.5}],
        },
        "controls": list(controls),
    }


def _round(cid: str, x: float, y: float, dia: float, **extra) -> dict:
    c = {
        "id": cid, "label": cid.upper(), "type": "illuminated_button_22",
        "x": x, "y": y, "safety_critical": False,
        "cutout": {"kind": "round", "diameter": dia}, "notes": "synthetic",
    }
    c.update(extra)
    return c


def test_body_diameter_defaults_to_cutout_diameter():
    plain = _round("plain", 50, 50, 22.5)
    assert v.body_bbox(plain) == v.cutout_bbox(plain)
    assert v.body_bbox(plain) == (38.75, 38.75, 61.25, 61.25)


def test_body_diameter_overrides_the_cutout_envelope():
    big = _round("big", 50, 50, 22.5, body_diameter=40)
    assert v.body_bbox(big) == (30.0, 30.0, 70.0, 70.0)
    assert v.cutout_bbox(big) == (38.75, 38.75, 61.25, 61.25)  # cutout untouched


def test_rect_control_body_falls_back_to_the_cutout_box(spec):
    dsi = _find(spec, "dsi_screen")
    assert v.body_bbox(dsi) == v.cutout_bbox(dsi)


def test_body_to_body_overlap_is_an_error():
    # Cutouts are 60 mm apart (no web violation); the Ø76 bodies collide.
    errors = v.validate_bodies(_synthetic(
        _round("wheel_a", 100, 150, 50, body_diameter=76),
        _round("wheel_b", 160, 150, 50, body_diameter=76),
    ))
    assert any(
        "bodies" in e and "wheel_a" in e and "wheel_b" in e and "16.00 mm in x" in e
        for e in errors
    ), errors


def test_body_overhanging_another_controls_cutout_is_an_error():
    errors = v.validate_bodies(_synthetic(
        _round("wheel", 100, 150, 50, body_diameter=76),
        _round("btn", 145, 150, 22.5),
    ))
    assert any(
        "body 'wheel' overhangs the cutout of 'btn'" in e for e in errors
    ), errors


def test_body_crossing_the_panel_outline_is_an_error():
    # Ø50 cutout is fully inside; the Ø76 body hangs off the right edge.
    errors = v.validate_bodies(_synthetic(
        _round("wheel", 310, 150, 50, body_diameter=76), width=340, height=290,
    ))
    assert any(
        "body envelope crosses the panel outline" in e and "wheel" in e
        and "8.00 mm" in e for e in errors
    ), errors


def test_body_intruding_on_another_controls_label_zone_is_an_error():
    errors = v.validate_bodies(_synthetic(
        _round("wheel", 100, 150, 50, body_diameter=76),
        _round("btn", 100, 60, 22.5,
               label_zone={"x": 90, "y": 105, "w": 30, "h": 10}),
    ))
    assert any(
        # wheel body spans y 112..188; the zone ends at y=115 → 3 mm intrusion
        "body 'wheel' intrudes on the label_zone of 'btn'" in e and "3.00 mm in y" in e
        for e in errors
    ), errors


def test_a_control_body_may_sit_in_its_own_label_zone():
    # Knob graduations are printed under the knob skirt; self must be exempt.
    errors = v.validate_bodies(_synthetic(
        _round("knob", 100, 150, 10, body_diameter=30,
               label_zone={"x": 80, "y": 130, "w": 40, "h": 40}),
    ))
    assert errors == [], errors


def test_bodies_closer_than_min_web_but_not_touching_is_not_an_error():
    """min_web is a MATERIAL rule for holes; it must not be applied to bodies.

    Two Ø30 knob bodies with a 2 mm air gap — well under the 6 mm min_web —
    are perfectly legal, while their Ø10 cutouts remain a comfortable 22 mm
    apart and so satisfy the web rule.
    """
    spec = _synthetic(
        _round("knob_a", 100, 150, 10, body_diameter=30),
        _round("knob_b", 132, 150, 10, body_diameter=30),
    )
    assert v.bbox_gap(v.body_bbox(spec["controls"][0]),
                      v.body_bbox(spec["controls"][1])) == pytest.approx(2.0)
    assert 2.0 < spec["panel"]["min_web"]
    assert v.validate_geometry(spec) == []


def test_bodies_exactly_touching_is_not_an_error():
    assert v.validate_bodies(_synthetic(
        _round("a", 100, 150, 10, body_diameter=30),
        _round("b", 130, 150, 10, body_diameter=30),
    )) == []


def test_body_smaller_than_its_own_cutout_is_an_error():
    errors = v.validate_bodies(_synthetic(
        _round("bad", 100, 150, 22.5, body_diameter=10),
    ))
    assert any(
        "body_diameter" in e and "bad" in e and "smaller than its cutout" in e
        for e in errors
    ), errors


def test_body_rules_are_aggregated_not_raised_early():
    """The validator's contract is that ALL failures surface in one run."""
    errors = v.validate_bodies(_synthetic(
        _round("wheel", 330, 150, 50, body_diameter=76),   # off the right edge
        _round("btn", 300, 150, 22.5,                      # body-to-cutout
               label_zone={"x": 295, "y": 190, "w": 20, "h": 8}),
        _round("knob", 310, 200, 10, body_diameter=30),    # body-to-body + label
    ))
    kinds = {
        "outline": any("crosses the panel outline" in e for e in errors),
        "body_body": any("bodies" in e for e in errors),
        "body_cutout": any("overhangs the cutout" in e for e in errors),
        "label": any("intrudes on the label_zone" in e for e in errors),
    }
    assert all(kinds.values()), (kinds, errors)


# ---------------------------------------------------------------------------
# body_diameter / label_zone as shipped
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "cid,expected",
    [("mpg", 76), ("estop", 40), ("feed_override", 30), ("axis_select", 30),
     ("step_select", 30), ("spindle_ovr", 24), ("enable", 24)],
)
def test_shipped_body_diameters(spec, cid, expected):
    assert _find(spec, cid)["body_diameter"] == expected


@pytest.mark.parametrize(
    "cid", ["start", "hold", "reset", "spindle", "dust", "led_pwr", "led_link",
            "led_homed", "led_alarm", "led_probe"],
)
def test_flush_controls_omit_body_diameter(spec, cid):
    """Ø22 buttons and Ø8 LED bezels are flush; they must rely on the default."""
    c = _find(spec, cid)
    assert "body_diameter" not in c
    assert v.body_bbox(c) == v.cutout_bbox(c)


def test_every_body_is_at_least_its_cutout(spec):
    for c in spec["controls"]:
        if c["cutout"]["kind"] == "round":
            assert c.get("body_diameter", c["cutout"]["diameter"]) >= c["cutout"]["diameter"]


def test_reset_label_zone_matches_the_mockup_baselines(spec):
    """RESET's zone is the one the MPG was covering — pin its derivation.

    lbl baseline y=146 @ 3.4 px  → top    = 146 − 0.80*3.4 = 143.28 → 143.2
    sub baseline y=150.5 @ 2.6 px → bottom = 150.5 + 0.20*2.6 = 151.02 → 151.1
    """
    z = _find(spec, "reset")["label_zone"]
    assert (z["x"], z["y"], z["w"], z["h"]) == (273.7, 143.2, 32.6, 7.9)
    assert z["y"] + z["h"] == pytest.approx(151.1)
    # The corrected wheel clears it: body top = 192 − 38 = 154.
    assert v.body_bbox(_find(spec, "mpg"))[1] == 154.0


def test_controls_without_a_label_zone_are_documented(spec):
    """Only estop (legend on its own plate) and dsi_screen (no legend) lack one."""
    missing = {c["id"] for c in spec["controls"] if "label_zone" not in c}
    assert missing == {"estop", "dsi_screen"}


def test_label_zones_lie_within_the_panel(spec):
    w, h = spec["panel"]["width"], spec["panel"]["height"]
    for c in spec["controls"]:
        box = v.label_zone_bbox(c)
        if box is None:
            continue
        x0, y0, x1, y1 = box
        assert 0 <= x0 and 0 <= y0 and x1 <= w and y1 <= h, c["id"]


def test_label_zone_bbox_returns_none_when_absent():
    assert v.label_zone_bbox(_round("x", 10, 10, 8)) is None


def test_schema_accepts_body_diameter_and_label_zone(spec, schema):
    assert v.validate_schema(spec, schema) == ["DELIBERATE FAILURE - issue #158 negative verification"]


def test_schema_rejects_body_diameter_on_a_rect_cutout(spec, schema):
    _find(spec, "dsi_screen")["body_diameter"] = 200
    assert v.validate_schema(spec, schema) != []


def test_schema_rejects_a_malformed_label_zone(spec, schema):
    _find(spec, "reset")["label_zone"] = {"x": 1, "y": 2, "w": 3}  # missing h
    assert v.validate_schema(spec, schema) != []
