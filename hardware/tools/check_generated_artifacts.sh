#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check_generated_artifacts.sh — regenerate the panel mockup SVG and diff it
# against a committed copy, so drift becomes a red build (issue #117).
#
# docs/hardware/panel-mockup.svg is a GENERATED ARTIFACT of hardware/panel-spec.yaml.
# This script proves the committed copy is a clean regeneration: it regenerates
# into a scratch directory and diffs. It exits 0 on a match and NON-ZERO,
# printing the offending diff, on any difference.
#
# Usage:
#   check_generated_artifacts.sh [SCRATCH_DIR] [SVG_TO_CHECK]
#
#   SCRATCH_DIR   Caller-provided writable scratch directory. If omitted, one is
#                 created with `mktemp -d`. It is NEVER a hardcoded system temp
#                 path. May also be supplied via $SHAPEOKO_SCRATCH_DIR. A scratch
#                 dir created by this script is removed on exit; a caller-provided
#                 one is left untouched.
#   SVG_TO_CHECK  The committed SVG to compare against. Defaults to
#                 docs/hardware/panel-mockup.svg. The regression test points this
#                 at a deliberately mutated copy to prove the failure path.
#
# Environment:
#   PYTHON        Python interpreter to run the generator (default: python3). It
#                 must have the hardware toolchain deps (pyyaml, jsonschema)
#                 importable — e.g. the editable install used in CI, or the
#                 project venv locally.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GENERATOR="${SCRIPT_DIR}/generate_panel_svg.py"
PYTHON="${PYTHON:-python3}"

SCRATCH_DIR="${1:-${SHAPEOKO_SCRATCH_DIR:-}}"
SVG_TO_CHECK="${2:-${REPO_ROOT}/docs/hardware/panel-mockup.svg}"

CLEANUP_SCRATCH=0
if [[ -z "${SCRATCH_DIR}" ]]; then
  SCRATCH_DIR="$(mktemp -d)"
  CLEANUP_SCRATCH=1
fi

# A scratch dir we created is removed on exit; a caller-provided one is left as-is.
trap '[[ "${CLEANUP_SCRATCH}" -eq 1 ]] && rm -rf "${SCRATCH_DIR}"' EXIT

if [[ ! -d "${SCRATCH_DIR}" ]]; then
  echo "ERROR: scratch directory does not exist: ${SCRATCH_DIR}" >&2
  exit 2
fi
if [[ ! -f "${SVG_TO_CHECK}" ]]; then
  echo "ERROR: SVG to check does not exist: ${SVG_TO_CHECK}" >&2
  exit 2
fi

REGENERATED="${SCRATCH_DIR}/panel-mockup.regenerated.svg"

# Regenerate from the committed spec. The generator validates the spec first and
# writes nothing on failure, so a bad spec fails here rather than producing a
# misleading diff.
"${PYTHON}" "${GENERATOR}" --output "${REGENERATED}"

if diff -u "${SVG_TO_CHECK}" "${REGENERATED}"; then
  echo "OK: ${SVG_TO_CHECK} matches a fresh regeneration."
  exit 0
fi

echo "" >&2
echo "ERROR: ${SVG_TO_CHECK} does NOT match a fresh regeneration of the spec." >&2
echo "The SVG is a generated artifact — do not hand-edit it. Edit hardware/panel-spec.yaml" >&2
echo "and regenerate with: python hardware/tools/generate_panel_svg.py" >&2
exit 1
