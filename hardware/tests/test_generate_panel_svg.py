"""Unit and integration tests for the panel-mockup SVG generator.

Mirrors the conventions in ``test_validate_panel_spec.py``: the committed spec is
loaded and only *in-memory copies* are mutated, so the committed spec and SVG on
disk are never touched. Scratch directories always come from pytest's ``tmp_path``
fixture — never a hardcoded system temp path.

The most important test here is :func:`test_check_script_fails_on_mutated_svg`:
it is the committed proof that the regeneration diff check actually FAILS when the
SVG drifts from the spec, so the failure path is a regression test rather than a
one-time observation (issue #117).
"""

from __future__ import annotations

import copy
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

import generate_panel_svg as gen
import validate_panel_spec as v
from generate_panel_svg import GeneratorError

HARDWARE = Path(__file__).resolve().parent.parent
REPO_ROOT = HARDWARE.parent
SPEC_PATH = HARDWARE / "panel-spec.yaml"
SCHEMA_PATH = HARDWARE / "panel-spec.schema.json"
GENERATOR = HARDWARE / "tools" / "generate_panel_svg.py"
CHECK_SCRIPT = HARDWARE / "tools" / "check_generated_artifacts.sh"
COMMITTED_SVG = REPO_ROOT / "docs" / "hardware" / "panel-mockup.svg"

EXPECTED_CONTROL_COUNT = 20

# Distinctive multi-word legends that must not be hardcoded in the generator and
# must appear in the output. Single words (e.g. "PROBE") are avoided here because
# they legitimately recur in cosmetic fake-UI text.
DISTINCTIVE_LEGENDS = [
    "EMERGENCY STOP",
    "PULL TO RELEASE",
    "FEED OVERRIDE %",
    "SPINDLE OVR %",
    "MPG HANDWHEEL",
    "hold to jog",
    "cycle start / resume",
    "soft reset / clear alarm",
    "RF · auto · lit = confirmed",
    "M3/M5 · lit = running",
]


@pytest.fixture
def spec() -> dict:
    return v.load_yaml(SPEC_PATH)


def _find(spec: dict, control_id: str) -> dict:
    for c in spec["controls"]:
        if c["id"] == control_id:
            return c
    raise AssertionError(f"control {control_id} not found")


def _control_block(svg: str, control_id: str) -> list[str]:
    """Return the lines of one control's <g> block (comment marker .. </g>)."""
    lines = svg.split("\n")
    block: list[str] = []
    capturing = False
    for line in lines:
        if line.strip().startswith(f"<!-- control: {control_id} "):
            capturing = True
        if capturing:
            block.append(line)
        if capturing and line.strip() == "</g>":
            break
    return block


def _without_control(svg: str, control_id: str) -> str:
    """Return the SVG with one control's <g> block removed (everything else)."""
    lines = svg.split("\n")
    out: list[str] = []
    skipping = False
    for line in lines:
        if line.strip().startswith(f"<!-- control: {control_id} "):
            skipping = True
        if not skipping:
            out.append(line)
        if skipping and line.strip() == "</g>":
            skipping = False
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------
def test_generate_twice_is_byte_identical(spec):
    assert gen.generate_svg(spec) == gen.generate_svg(copy.deepcopy(spec))


def test_generate_is_deterministic_across_processes():
    """Separate processes with different PYTHONHASHSEED must agree byte-for-byte.

    This catches any accidental dependence on set/dict hash-iteration order.
    """

    def run(seed: str) -> str:
        env = dict(os.environ, PYTHONHASHSEED=seed)
        result = subprocess.run(
            [sys.executable, str(GENERATOR), "--stdout"],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
        return result.stdout

    assert run("0") == run("12345")


def test_committed_svg_is_a_clean_regeneration(spec):
    """The committed artifact on disk equals a fresh generation (what CI checks)."""
    assert COMMITTED_SVG.read_text(encoding="utf-8") == gen.generate_svg(spec)


# ---------------------------------------------------------------------------
# Content
# ---------------------------------------------------------------------------
def test_panel_outline_present(spec):
    svg = gen.generate_svg(spec)
    assert 'width="340" height="290"' in svg  # 340 x 290 mm outline


def test_every_control_id_appears(spec):
    svg = gen.generate_svg(spec)
    assert len(spec["controls"]) == EXPECTED_CONTROL_COUNT
    for control in spec["controls"]:
        assert f"<!-- control: {control['id']} " in svg


def test_every_legend_from_spec_appears(spec):
    svg = gen.generate_svg(spec)
    for control in spec["controls"]:
        for key in ("label", "sub_label"):
            if key in control:
                assert control[key] in svg, f"{control['id']}.{key} missing from SVG"


def test_dust_sub_label_is_rf_wording(spec):
    svg = gen.generate_svg(spec)
    assert "RF · auto · lit = confirmed" in svg
    # exactly the spec value, drawn as the DUST sub-label
    assert _find(spec, "dust")["sub_label"] == "RF · auto · lit = confirmed"


def test_word_relay_never_appears(spec):
    """The superseded relay design must leave no trace in the generated SVG."""
    svg = gen.generate_svg(spec)
    assert "relay" not in svg.lower()


def test_legends_are_not_hardcoded_in_generator(spec):
    """Distinctive legends must come from the spec, not literals in the source.

    Checks only *non-docstring* string literals in the generator: a hardcoded
    legend would be a string constant used by drawing code. Docstrings (which
    legitimately mention example legends) are excluded.
    """
    import ast

    source = GENERATOR.read_text(encoding="utf-8")
    tree = ast.parse(source)
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = node.body
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                docstrings.add(id(body[0].value))
    code_literals = "\n".join(
        n.value
        for n in ast.walk(tree)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings
    )

    svg = gen.generate_svg(spec)
    for legend in DISTINCTIVE_LEGENDS:
        assert legend in svg, f"expected legend {legend!r} in output"
        assert legend not in code_literals, f"legend {legend!r} is hardcoded in the generator"


def test_changing_a_label_changes_the_output(spec):
    """A wording change is a spec edit: mutating a label flows into the SVG."""
    base = gen.generate_svg(spec)
    mutated = copy.deepcopy(spec)
    _find(mutated, "dust")["sub_label"] = "RF · zzz sentinel"
    out = gen.generate_svg(mutated)
    assert "RF · zzz sentinel" in out
    assert "RF · auto · lit = confirmed" not in out
    assert out != base


# ---------------------------------------------------------------------------
# Moving one control moves exactly that control
# ---------------------------------------------------------------------------
def test_moving_one_control_moves_only_that_control(spec):
    base = gen.generate_svg(spec)
    moved = copy.deepcopy(spec)
    _find(moved, "dust")["x"] = float(_find(spec, "dust")["x"]) + 25
    out = gen.generate_svg(moved)

    # Everything except the dust block is byte-identical...
    assert _without_control(base, "dust") == _without_control(out, "dust")
    # ...and the dust block itself changed.
    assert _control_block(base, "dust") != _control_block(out, "dust")


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------
def test_unknown_control_type_raises_naming_the_type(spec):
    bad = copy.deepcopy(spec)
    bad["controls"][0]["type"] = "flux_capacitor"
    with pytest.raises(GeneratorError) as excinfo:
        gen.generate_svg(bad)
    assert "flux_capacitor" in str(excinfo.value)


def test_all_enum_types_have_a_routine():
    """Every legal control type in the schema has a drawing routine."""
    schema = v.load_schema(SCHEMA_PATH)
    enum = schema["definitions"]["control"]["properties"]["type"]["enum"]
    assert set(enum) == set(gen._DISPATCH), "dispatch table and schema enum diverged"


def test_invalid_spec_writes_no_output_and_exits_nonzero(tmp_path):
    bad_spec = tmp_path / "bad.yaml"
    data = v.load_yaml(SPEC_PATH)
    data["panel"]["width"] = -5  # schema violation
    bad_spec.write_text(yaml.safe_dump(data), encoding="utf-8")
    out = tmp_path / "out.svg"

    rc = gen.main(["--spec", str(bad_spec), "--schema", str(SCHEMA_PATH), "--output", str(out)])
    assert rc != 0
    assert not out.exists(), "no SVG must be written when the spec is invalid"


def test_committed_svg_untouched_by_failed_generation(tmp_path):
    """A failing generation must not touch an existing --output file."""
    target = tmp_path / "existing.svg"
    target.write_text("SENTINEL", encoding="utf-8")
    bad_spec = tmp_path / "bad.yaml"
    data = v.load_yaml(SPEC_PATH)
    data["controls"][0]["type"] = "not_a_real_type"
    bad_spec.write_text(yaml.safe_dump(data), encoding="utf-8")

    rc = gen.main(["--spec", str(bad_spec), "--schema", str(SCHEMA_PATH), "--output", str(target)])
    assert rc != 0
    assert target.read_text(encoding="utf-8") == "SENTINEL"


# ---------------------------------------------------------------------------
# check_generated_artifacts.sh — the committed proof of the failure path
# ---------------------------------------------------------------------------
def _run_check(scratch: Path, svg_to_check: Path | None = None):
    args = [str(CHECK_SCRIPT), str(scratch)]
    if svg_to_check is not None:
        args.append(str(svg_to_check))
    env = dict(os.environ, PYTHON=sys.executable)
    return subprocess.run(args, capture_output=True, text=True, env=env)


def test_check_script_passes_on_committed_pair(tmp_path):
    result = _run_check(tmp_path)
    assert result.returncode == 0, result.stderr + result.stdout


def test_check_script_fails_on_mutated_svg(tmp_path):
    """THE critical test: a deliberately mutated SVG makes the check exit non-zero.

    This is the committed regression test the issue requires — proof that the
    regeneration diff check actually catches drift, in a caller-provided scratch
    directory (pytest ``tmp_path``), never a hardcoded system temp path.
    """
    mutated = tmp_path / "mutated.svg"
    original = COMMITTED_SVG.read_text(encoding="utf-8")
    # One deliberate character change that no spec edit produced.
    mutated_text = original.replace("EMERGENCY STOP", "EMERGENCY STOZ", 1)
    assert mutated_text != original, "mutation must actually change the SVG"
    mutated.write_text(mutated_text, encoding="utf-8")

    result = _run_check(tmp_path, mutated)
    assert result.returncode != 0, "check must fail on a drifted SVG"
    # It must print the offending diff.
    assert "EMERGENCY STOZ" in (result.stdout + result.stderr)


def test_check_script_creates_scratch_when_not_provided():
    """With no scratch dir argument the script provisions one via mktemp -d."""
    env = dict(os.environ, PYTHON=sys.executable)
    result = subprocess.run(
        [str(CHECK_SCRIPT)], capture_output=True, text=True, env=env
    )
    assert result.returncode == 0, result.stderr + result.stdout
