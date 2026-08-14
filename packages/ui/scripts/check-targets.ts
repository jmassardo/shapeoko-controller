/**
 * `check:targets` CLI — the touch-target size gate for CI.
 *
 * THIN wrapper only. All reusable logic lives in
 * `packages/ui/src/tokens/targets.ts` (the single source of truth, exercised
 * directly by the Vitest gate in `targets.test.ts`). This script's ONLY jobs are
 * to run the registered-target check and translate the result into a process
 * exit code — non-zero on any violation, so an undersized control fails CI
 * rather than merely warning.
 *
 * WHY it imports from `../dist` rather than `../src`: this repo's ESM uses `.js`
 * import specifiers that point at `.ts` sources, a rewrite only `tsc`/Vitest
 * perform — bare Node's type-stripping does NOT resolve `.js` to a sibling
 * `.ts`. So the `check:targets` npm script builds the package first (`tsc`) and
 * this wrapper loads the COMPILED logic from `dist`, which is byte-for-byte the
 * same code `src/tokens/targets.ts` produces. Node runs this `.ts` wrapper
 * itself via built-in type stripping (Node >= 26).
 */

import { REGISTERED_TARGETS, evaluateTargetCheck } from '../dist/tokens/targets.js';

const result = evaluateTargetCheck(REGISTERED_TARGETS);

if (result.exitCode === 0) {
  console.log(`check:targets — ${result.message}`);
  process.exit(0);
}

console.error(`check:targets — ${result.message}`);
process.exit(result.exitCode);
