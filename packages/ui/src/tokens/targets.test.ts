/**
 * Touch-target size gate tests.
 *
 * Renders representative interactive controls in jsdom and asserts the checker
 * behaviour that CI depends on:
 *  - compliant controls (>= 72 px on both axes) produce no violations;
 *  - undersized controls FAIL, per axis and on both;
 *  - a DISABLED control is still measured and still enforced (gloved operators
 *    must identify and read it);
 *  - buttons, links, form controls, `[role=button]`, and explicitly registered
 *    custom targets are all collected;
 *  - a violation makes the CLI-facing checker return a NON-ZERO exit code
 *    rather than merely warning (the exact result the `check-targets.ts`
 *    wrapper turns into a process exit code).
 *
 * jsdom performs no layout, so `getBoundingClientRect()` is zero here. The
 * checker's `defaultMeasure` therefore reads explicit inline pixel sizes, which
 * these tests set — a deliberate, deterministic measurement strategy.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { MIN_TARGET_PX } from './spacing.js';
import {
  CONTROL_SIZE,
  REGISTERED_TARGETS,
  collectInteractiveElements,
  evaluateTargetCheck,
  findTargetViolations,
  measureTargets,
} from './targets.js';

/** Create an element with an explicit inline pixel hit area and append it. */
function addControl(
  tag: string,
  widthPx: number,
  heightPx: number,
  attributes: Record<string, string> = {},
): HTMLElement {
  const element = document.createElement(tag);
  element.style.width = `${widthPx}px`;
  element.style.height = `${heightPx}px`;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collecting interactive elements', () => {
  it('collects buttons, links, form controls, and role=button', () => {
    addControl('button', 72, 72);
    addControl('a', 72, 72, { href: '#go' });
    addControl('input', 72, 72, { type: 'text' });
    addControl('select', 72, 72);
    addControl('textarea', 72, 72);
    addControl('div', 72, 72, { role: 'button' });

    const found = collectInteractiveElements(document);
    const tags = found.map((element) => element.tagName.toLowerCase());
    expect(tags).toContain('button');
    expect(tags).toContain('a');
    expect(tags).toContain('input');
    expect(tags).toContain('select');
    expect(tags).toContain('textarea');
    expect(found.some((element) => element.getAttribute('role') === 'button')).toBe(true);
    expect(found).toHaveLength(6);
  });

  it('collects explicitly registered custom targets via data-touch-target', () => {
    addControl('div', 72, 72, { 'data-touch-target': 'jog-pad' });
    const found = collectInteractiveElements(document);
    expect(found).toHaveLength(1);
  });

  it('collects extra registered targets passed by the caller', () => {
    const custom = document.createElement('span');
    custom.style.width = '72px';
    custom.style.height = '72px';
    // Not attached to the document and not matched by the selector.
    const found = collectInteractiveElements(document, [custom]);
    expect(found).toContain(custom);
  });

  it('does not double-count an element that both matches and is passed as extra', () => {
    const button = addControl('button', 72, 72);
    const found = collectInteractiveElements(document, [button]);
    expect(found).toHaveLength(1);
  });
});

describe('target-size violations', () => {
  it('passes compliant controls at exactly the minimum', () => {
    addControl('button', MIN_TARGET_PX, MIN_TARGET_PX);
    expect(findTargetViolations(document)).toHaveLength(0);
  });

  it('fails an undersized control on both axes', () => {
    addControl('button', 48, 48);
    const violations = findTargetViolations(document);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.axis).toBe('both');
  });

  it('fails a control that is under on width only', () => {
    addControl('button', 40, 96);
    const violations = findTargetViolations(document);
    expect(violations[0]?.axis).toBe('width');
  });

  it('fails a control that is under on height only', () => {
    addControl('button', 96, 40);
    const violations = findTargetViolations(document);
    expect(violations[0]?.axis).toBe('height');
  });

  it('one pixel under the minimum is a violation (hard boundary)', () => {
    addControl('button', MIN_TARGET_PX - 1, MIN_TARGET_PX);
    expect(findTargetViolations(document)).toHaveLength(1);
  });
});

describe('disabled controls', () => {
  it('still measures a disabled control (it is not skipped)', () => {
    addControl('button', 72, 72, { disabled: '' });
    const measured = measureTargets(document);
    expect(measured).toHaveLength(1);
    expect(measured[0]?.widthPx).toBe(72);
  });

  it('still ENFORCES the minimum on a disabled control', () => {
    // A gloved operator must be able to identify and read it, so an undersized
    // disabled control is a violation just like an enabled one.
    addControl('button', 60, 60, { disabled: '' });
    const violations = findTargetViolations(document);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.description).toContain('[disabled]');
  });

  it('passes a compliant disabled control', () => {
    addControl('button', 80, 80, { disabled: '' });
    expect(findTargetViolations(document)).toHaveLength(0);
  });
});

describe('measurement strategy', () => {
  it('honours an injected measurement function', () => {
    addControl('button', 10, 10);
    const violations = findTargetViolations(document, {
      measure: () => ({ widthPx: 100, heightPx: 100 }),
    });
    expect(violations).toHaveLength(0);
  });

  it('respects a caller-supplied minimum edge', () => {
    addControl('button', 72, 72);
    const violations = findTargetViolations(document, { minPx: 96 });
    expect(violations).toHaveLength(1);
  });
});

describe('CLI-facing checker (exit codes)', () => {
  it('returns exit code 0 for the registered baseline targets', () => {
    const result = evaluateTargetCheck(REGISTERED_TARGETS);
    expect(result.exitCode).toBe(0);
    expect(result.violations).toHaveLength(0);
  });

  it('every design-system control token meets the minimum on both axes', () => {
    for (const size of Object.values(CONTROL_SIZE)) {
      expect(size.widthPx).toBeGreaterThanOrEqual(MIN_TARGET_PX);
      expect(size.heightPx).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    }
  });

  it('returns a NON-ZERO exit code when a target is undersized', () => {
    const result = evaluateTargetCheck([
      { description: 'undersized-widget', widthPx: 50, heightPx: 50 },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.message).toContain('undersized-widget');
  });
});
