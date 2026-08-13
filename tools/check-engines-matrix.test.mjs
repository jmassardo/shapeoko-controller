// check-engines-matrix.test.mjs
//
// Unit tests for the engines/matrix coherence assertion (issue #14 test plan:
// "assert engines.node is a bounded range and that the CI matrix major
// satisfies it"). Uses Node's built-in test runner — no npm dependency — and
// exercises the pure helpers against fixtures, including the regression the AC
// names explicitly: an unbounded `engines` floor must make the check fail.
//
// Run: `node --test tools/check-engines-matrix.test.mjs`

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBoundedRange,
  majorSatisfiesRange,
  extractMatrixMajors,
  assertCoherent,
} from './check-engines-matrix.mjs';

test('parseBoundedRange accepts the project range >=26.5.0 <27.0.0', () => {
  const bounds = parseBoundedRange('>=26.5.0 <27.0.0');
  assert.deepEqual(bounds.lower, { major: 26, minor: 5, patch: 0 });
  assert.deepEqual(bounds.upper, { major: 27, minor: 0, patch: 0 });
});

test('parseBoundedRange REJECTS an unbounded floor ">=26"', () => {
  assert.throws(() => parseBoundedRange('>=26'), /UNBOUNDED/);
});

test('parseBoundedRange REJECTS the old ">=22" defect', () => {
  assert.throws(() => parseBoundedRange('>=22'), /UNBOUNDED|lower bound/);
});

test('parseBoundedRange rejects empty/missing input', () => {
  assert.throws(() => parseBoundedRange(''), /missing or empty/);
  assert.throws(() => parseBoundedRange(undefined), /missing or empty/);
});

test('majorSatisfiesRange: 26 is inside >=26.5.0 <27.0.0, 25 and 27 are not', () => {
  const bounds = parseBoundedRange('>=26.5.0 <27.0.0');
  assert.equal(majorSatisfiesRange(26, bounds), true);
  assert.equal(majorSatisfiesRange(25, bounds), false);
  assert.equal(majorSatisfiesRange(27, bounds), false);
  assert.equal(majorSatisfiesRange(22, bounds), false);
});

test('extractMatrixMajors parses a quoted "26.x" matrix', () => {
  assert.deepEqual(extractMatrixMajors("node-version: ['26.x']"), [26]);
});

test('extractMatrixMajors parses multiple / mixed entries and dedupes', () => {
  assert.deepEqual(extractMatrixMajors('node-version: ["26.x", 26, 24.1.0]'), [26, 24]);
});

test('extractMatrixMajors throws when no matrix is present', () => {
  assert.throws(() => extractMatrixMajors('name: ci\n'), /node-version/);
});

test('assertCoherent passes for the shipped config', () => {
  const { bounds, majors } = assertCoherent(
    '>=26.5.0 <27.0.0',
    "    strategy:\n      matrix:\n        node-version: ['26.x']\n",
  );
  assert.deepEqual(majors, [26]);
  assert.equal(bounds.upper.major, 27);
});

test('assertCoherent FAILS when the matrix major drifts from engines', () => {
  assert.throws(
    () => assertCoherent('>=26.5.0 <27.0.0', "node-version: ['24.x']"),
    /do not satisfy/,
  );
});

test('assertCoherent FAILS when engines is reverted to an unbounded floor', () => {
  // The AC: "given someone later reverts engines to an unbounded floor, when
  // CI runs, then the matrix/engines agreement assertion fails."
  assert.throws(() => assertCoherent('>=26', "node-version: ['26.x']"), /UNBOUNDED/);
});
