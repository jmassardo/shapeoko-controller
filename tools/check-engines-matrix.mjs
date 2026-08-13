#!/usr/bin/env node
// check-engines-matrix.mjs
//
// Guards the Node-version coherence contract that issue #14 established:
//
//   1. Root package.json `engines.node` MUST be a BOUNDED range — it needs both
//      a lower bound (>=) and an upper bound (<). An open-ended floor such as
//      ">=26" is rejected, because an unbounded floor is a wish, not a target:
//      it silently validates on any future major (which is how four majors of
//      drift went unnoticed on this project).
//
//   2. The CI workflow's Node matrix (`node-version:` under the node job) MUST
//      only contain majors that satisfy that bounded range. If someone bumps
//      the matrix or loosens `engines` so the two disagree, this fails.
//
// Run standalone: `node tools/check-engines-matrix.mjs` (exits non-zero on
// violation). The pure logic lives in exported helpers so it can be unit-tested
// (see check-engines-matrix.test.mjs) without touching the filesystem.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

/**
 * Parse an `engines.node` string into its bounded lower/upper semver bounds.
 * Only the shape this project commits to is accepted: a `>=X.Y.Z` lower bound
 * AND a `<A.B.C` upper bound, in either order, space-separated.
 *
 * @param {string} range
 * @returns {{ lower: { major: number, minor: number, patch: number },
 *             upper: { major: number, minor: number, patch: number } }}
 * @throws {Error} if the range is missing either bound (i.e. is unbounded).
 */
export function parseBoundedRange(range) {
  if (typeof range !== 'string' || range.trim() === '') {
    throw new Error('engines.node is missing or empty');
  }

  const lowerMatch = range.match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  const upperMatch = range.match(/<\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);

  if (!lowerMatch) {
    throw new Error(`engines.node "${range}" has no lower bound of the form ">=X.Y.Z"`);
  }
  if (!upperMatch) {
    throw new Error(
      `engines.node "${range}" is UNBOUNDED: it has no upper bound of the ` +
        `form "<A.B.C". An open-ended floor lets any future major silently ` +
        `become the de-facto target. Use e.g. ">=26.5.0 <27.0.0".`,
    );
  }

  const toVer = (m) => ({
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
  });

  return { lower: toVer(lowerMatch), upper: toVer(upperMatch) };
}

/**
 * Does the CI matrix entry (a Node major, e.g. 26 from "26.x") fall inside the
 * bounded range? A major M is accepted when lower.major <= M < upper.major.
 *
 * @param {number} major
 * @param {ReturnType<typeof parseBoundedRange>} bounds
 * @returns {boolean}
 */
export function majorSatisfiesRange(major, bounds) {
  return major >= bounds.lower.major && major < bounds.upper.major;
}

/**
 * Extract the Node majors declared in a CI workflow's `node-version:` matrix.
 * Accepts values like `'26.x'`, `"26.x"`, `26`, `26.5.0`. Returns unique
 * integer majors in declaration order.
 *
 * @param {string} workflowYaml
 * @returns {number[]}
 */
export function extractMatrixMajors(workflowYaml) {
  const listMatch = workflowYaml.match(/node-version:\s*\[([^\]]*)\]/);
  if (!listMatch) {
    throw new Error('could not find a `node-version: [ ... ]` matrix in the workflow');
  }

  const majors = [];
  for (const raw of listMatch[1].split(',')) {
    const token = raw.trim().replace(/^['"]|['"]$/g, '');
    if (token === '') continue;
    const major = Number(token.split('.')[0]);
    if (!Number.isInteger(major)) {
      throw new Error(`unparseable node-version matrix entry: "${raw.trim()}"`);
    }
    if (!majors.includes(major)) majors.push(major);
  }

  if (majors.length === 0) {
    throw new Error('the `node-version:` matrix is empty');
  }
  return majors;
}

/**
 * Full coherence check over the two source strings. Throws on any violation.
 *
 * @param {string} enginesNode
 * @param {string} workflowYaml
 * @returns {{ bounds: ReturnType<typeof parseBoundedRange>, majors: number[] }}
 */
export function assertCoherent(enginesNode, workflowYaml) {
  const bounds = parseBoundedRange(enginesNode);
  const majors = extractMatrixMajors(workflowYaml);

  const offenders = majors.filter((m) => !majorSatisfiesRange(m, bounds));
  if (offenders.length > 0) {
    throw new Error(
      `CI Node matrix major(s) [${offenders.join(', ')}] do not satisfy ` +
        `engines.node "${enginesNode}". The matrix and engines range have ` +
        `drifted apart — fix one so they agree.`,
    );
  }

  return { bounds, majors };
}

function main() {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const enginesNode = pkg?.engines?.node;
  const workflowYaml = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');

  try {
    const { bounds, majors } = assertCoherent(enginesNode, workflowYaml);
    console.log(
      `engines/matrix coherence OK: engines.node "${enginesNode}" ` +
        `(>=${bounds.lower.major}.${bounds.lower.minor}.${bounds.lower.patch} ` +
        `<${bounds.upper.major}.${bounds.upper.minor}.${bounds.upper.patch}); ` +
        `CI matrix major(s) [${majors.join(', ')}] all satisfy it.`,
    );
    process.exit(0);
  } catch (err) {
    console.error(`engines/matrix coherence FAILED: ${err.message}`);
    process.exit(1);
  }
}

// Only run the filesystem-backed check when executed directly, not when this
// module is imported by the unit tests (importing must have no side effects).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
