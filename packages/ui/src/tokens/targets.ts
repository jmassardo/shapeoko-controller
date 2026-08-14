/**
 * Touch-target tokens and the deterministic target-size checker.
 *
 * SINGLE SOURCE OF TRUTH for interactive hit-area sizing on the fixed 1024x600
 * kiosk, AND the reusable logic behind the target-size gate. It lives entirely
 * under `src/` on purpose: `packages/ui/tsconfig.json` sets `rootDir: "src"`, so
 * a file under `src/` may not import from `../scripts` (that would trip TS6059).
 * The CLI at `scripts/check-targets.ts` is therefore a THIN wrapper that imports
 * the logic here and calls `process.exit`. Tests import from `./targets.js`.
 *
 * WHY 72 px (see `MIN_TARGET_PX`): operators wear gloves near a running spindle,
 * so the usual 44-48 px touch minimum is not enough — a fingertip in a glove
 * needs a generous target. A control below 72 px on EITHER axis is a violation.
 *
 * MEASUREMENT STRATEGY (deliberate design decision): jsdom does not perform
 * layout, so `getBoundingClientRect()` returns zeros there. To keep the checker
 * DETERMINISTIC and unit-testable, `defaultMeasure` reads EXPLICIT inline
 * `style.width`/`style.height` pixel values first and only falls back to
 * `getBoundingClientRect()` when they are absent. Callers may also inject their
 * own `measure` function. This means a test can assert real sizes in jsdom
 * without a browser, and production code in a real browser still gets true
 * layout measurements via the rect fallback.
 */

import { MIN_TARGET_PX } from './spacing.js';

/**
 * CSS selector for the interactive elements the gate inspects: native buttons,
 * hyperlinks, form controls, ARIA buttons, and any element explicitly REGISTERED
 * as a custom target via the `data-touch-target` attribute.
 */
export const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [data-touch-target]';

/** A width/height measurement in pixels. */
export interface TargetMeasurement {
  /** Measured width in pixels. */
  readonly widthPx: number;
  /** Measured height in pixels. */
  readonly heightPx: number;
}

/** Function that measures one element's hit area. Injectable for determinism. */
export type MeasureFn = (element: Element) => TargetMeasurement;

/** A plain-data target description the checker can evaluate without a DOM. */
export interface TargetSpec {
  /** Human-readable description of the target (for diagnostics). */
  readonly description: string;
  /** Target width in pixels. */
  readonly widthPx: number;
  /** Target height in pixels. */
  readonly heightPx: number;
}

/** A target that failed the minimum-size gate, with which axis/axes failed. */
export interface TargetViolation extends TargetSpec {
  /** The minimum edge (px) the target failed to meet. */
  readonly minPx: number;
  /** Which axis (or both) was under the minimum. */
  readonly axis: 'width' | 'height' | 'both';
}

/** Result of a full target check, shaped for a CLI exit decision. */
export interface TargetCheckResult {
  /** Process-style exit code: 0 = all pass, 1 = at least one violation. */
  readonly exitCode: 0 | 1;
  /** The violations found (empty when `exitCode` is 0). */
  readonly violations: readonly TargetViolation[];
  /** Human-readable summary suitable for stdout/stderr. */
  readonly message: string;
}

/** Options controlling a DOM-based target scan. */
export interface TargetScanOptions {
  /** Custom measurement function (defaults to `defaultMeasure`). */
  readonly measure?: MeasureFn;
  /** Extra explicitly-registered targets not matched by the selector. */
  readonly extraTargets?: Iterable<Element>;
  /** Override the minimum edge in pixels (defaults to `MIN_TARGET_PX`). */
  readonly minPx?: number;
}

/** Parse a strict `<number>px` string, returning `null` when it does not match. */
function parsePx(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(value);
  if (!match) {
    return null;
  }
  const digits = match[1];
  if (digits === undefined) {
    return null;
  }
  return Number(digits);
}

/**
 * Default measurement: prefer explicit inline `style.width`/`style.height`
 * pixel values (deterministic under jsdom); fall back to
 * `getBoundingClientRect()` for real browser layout when inline sizes are
 * absent. A missing inline dimension falls back per-axis.
 */
export const defaultMeasure: MeasureFn = (element) => {
  const style = (element as Partial<HTMLElement>).style;
  const styleWidth = style ? parsePx(style.width) : null;
  const styleHeight = style ? parsePx(style.height) : null;
  if (styleWidth !== null && styleHeight !== null) {
    return { widthPx: styleWidth, heightPx: styleHeight };
  }
  const rect = element.getBoundingClientRect();
  return {
    widthPx: styleWidth ?? rect.width,
    heightPx: styleHeight ?? rect.height,
  };
};

/** Build a stable diagnostic description of an element for violation messages. */
function describeElement(element: Element, index: number): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const type = element.getAttribute('type');
  const role = element.getAttribute('role');
  const disabled = element.hasAttribute('disabled') ? ' [disabled]' : '';
  const typePart = type ? `[type=${type}]` : '';
  const rolePart = role ? `[role=${role}]` : '';
  return `${tag}${id}${typePart}${rolePart}${disabled} (index ${index})`;
}

/**
 * Collect every interactive element under `root`, including explicitly
 * registered custom targets (via `data-touch-target` or `extraTargets`).
 * Disabled controls ARE included: a disabled control must still be measured,
 * because a gloved operator has to identify and read it.
 */
export function collectInteractiveElements(
  root: ParentNode,
  extraTargets: Iterable<Element> = [],
): Element[] {
  const matched = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));
  const unique = new Set<Element>(matched);
  for (const element of extraTargets) {
    unique.add(element);
  }
  return Array.from(unique);
}

/** Measure every interactive element under `root` into plain `TargetSpec`s. */
export function measureTargets(root: ParentNode, options: TargetScanOptions = {}): TargetSpec[] {
  const measure = options.measure ?? defaultMeasure;
  const elements = collectInteractiveElements(root, options.extraTargets);
  return elements.map((element, index) => {
    const { widthPx, heightPx } = measure(element);
    return { description: describeElement(element, index), widthPx, heightPx };
  });
}

/** Evaluate plain target specs against the minimum edge; returns violations. */
export function checkTargetSpecs(
  specs: Iterable<TargetSpec>,
  minPx: number = MIN_TARGET_PX,
): TargetViolation[] {
  const violations: TargetViolation[] = [];
  for (const spec of specs) {
    const underWidth = spec.widthPx < minPx;
    const underHeight = spec.heightPx < minPx;
    if (!underWidth && !underHeight) {
      continue;
    }
    const axis: TargetViolation['axis'] =
      underWidth && underHeight ? 'both' : underWidth ? 'width' : 'height';
    violations.push({ ...spec, minPx, axis });
  }
  return violations;
}

/** Scan a DOM subtree and return every interactive element below the minimum. */
export function findTargetViolations(
  root: ParentNode,
  options: TargetScanOptions = {},
): TargetViolation[] {
  return checkTargetSpecs(measureTargets(root, options), options.minPx ?? MIN_TARGET_PX);
}

/**
 * Evaluate target specs into a CLI-friendly result. This is the single decision
 * point the `check-targets.ts` wrapper turns into a process exit code, and it is
 * what the tests assert on: any violation yields `exitCode: 1` (fail hard, do
 * not merely warn).
 */
export function evaluateTargetCheck(
  specs: readonly TargetSpec[],
  minPx: number = MIN_TARGET_PX,
): TargetCheckResult {
  const violations = checkTargetSpecs(specs, minPx);
  if (violations.length === 0) {
    return {
      exitCode: 0,
      violations,
      message: `All ${specs.length} registered target(s) meet the ${minPx}px minimum.`,
    };
  }
  const lines = violations.map(
    (violation) =>
      `  - ${violation.description}: ${violation.widthPx}x${violation.heightPx}px ` +
      `(min ${violation.minPx}px, under on ${violation.axis})`,
  );
  return {
    exitCode: 1,
    violations,
    message: `${violations.length} target(s) below the ${minPx}px minimum:\n${lines.join('\n')}`,
  };
}

/**
 * Named control-size tokens. Every interactive control the design system offers
 * is at least `MIN_TARGET_PX` on both axes. Screens must size controls from
 * these tokens rather than picking arbitrary dimensions.
 */
export const CONTROL_SIZE = {
  /** Square icon-only button — the smallest allowed interactive control. */
  iconButton: { widthPx: 72, heightPx: 72 },
  /** Standard labelled action button. */
  primaryButton: { widthPx: 220, heightPx: 88 },
  /** Jog-pad directional button. */
  jogButton: { widthPx: 112, heightPx: 112 },
  /** Full-width list/menu row. */
  listRow: { widthPx: 480, heightPx: 80 },
} as const;

/** Union of control-size token keys. */
export type ControlSizeKey = keyof typeof CONTROL_SIZE;

/**
 * The registered baseline targets the CLI validates on every run. These are the
 * design system's own control-size tokens turned into specs; because each is
 * >= `MIN_TARGET_PX` on both axes, a normal run exits 0. If a token were ever
 * edited below the minimum, the CLI would exit non-zero and block CI.
 */
export const REGISTERED_TARGETS: readonly TargetSpec[] = (
  Object.keys(CONTROL_SIZE) as ControlSizeKey[]
).map((key) => ({
  description: `CONTROL_SIZE.${key}`,
  widthPx: CONTROL_SIZE[key].widthPx,
  heightPx: CONTROL_SIZE[key].heightPx,
}));
