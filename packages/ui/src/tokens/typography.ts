/**
 * Typography tokens for the Shapeoko kiosk UI.
 *
 * SINGLE SOURCE OF TRUTH for type sizes and numeric rendering on the fixed
 * 1024x600 landscape panel. There are NO responsive breakpoints here (and there
 * must never be): the kiosk is exactly one screen, viewed at arm's length in a
 * workshop, so sizes are absolute pixels tuned for that one panel.
 *
 * Two hard legibility floors, enforced by `contrast.test.ts`:
 *  - Body text is >= 20 px so ordinary labels are readable across the bench.
 *  - Digital-read-out (DRO) numerals are >= 44 px because live position/feed
 *    numbers are read at a glance while the machine moves.
 *
 * DRO numerals also use TABULAR + LINING numeric settings so digits occupy a
 * constant width and do not jitter as coordinates change — see
 * `NUMERIC_FONT_FEATURE_SETTINGS` / `NUMERIC_FONT_VARIANT`.
 */

/** Hard floor for body text, in pixels. Enforced in tests for every density. */
export const BODY_MIN_PX = 20;

/** Hard floor for DRO numerals, in pixels. Enforced in tests for every density. */
export const DRO_MIN_PX = 44;

/**
 * CSS `font-feature-settings` value for numeric read-outs: tabular figures
 * (`tnum`) for constant digit width and lining figures (`lnum`) so digits align
 * to the cap height rather than dropping below the baseline.
 */
export const NUMERIC_FONT_FEATURE_SETTINGS = "'tnum' 1, 'lnum' 1";

/**
 * CSS `font-variant-numeric` equivalent of the feature settings above, provided
 * for consumers that prefer the higher-level property.
 */
export const NUMERIC_FONT_VARIANT = 'tabular-nums lining-nums';

/** UI font stack. A humanist sans with strong numerals; system fallbacks last. */
export const FONT_FAMILY = "'Inter', 'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Monospace stack reserved for raw GRBL/console output. */
export const MONO_FONT_FAMILY = "'JetBrains Mono', 'Roboto Mono', ui-monospace, monospace";

/**
 * One type scale. All sizes are absolute pixels for the fixed panel. `dro` is
 * the live read-out numeral size; the rest are ordinary UI text roles.
 */
export interface TypeScale {
  /** Caption / helper text size (px). */
  readonly captionPx: number;
  /** Body text size (px) — must be >= BODY_MIN_PX. */
  readonly bodyPx: number;
  /** Section heading size (px). */
  readonly headingPx: number;
  /** Screen-title size (px). */
  readonly titlePx: number;
  /** DRO numeral size (px) — must be >= DRO_MIN_PX. */
  readonly droPx: number;
  /** Unitless line-height multiplier for body/heading text. */
  readonly lineHeight: number;
}

/** Union of density scale keys. */
export type DensityKey = 'normal' | 'largeText';

/**
 * Density scales. `normal` is the default; `largeText` (the "LARGE TEXT" density)
 * is offered because the owner may prefer bigger type. BOTH scales still satisfy
 * the >= 20 px body and >= 44 px DRO floors — `largeText` simply raises them
 * further. Note captions in `largeText` are also lifted to >= BODY_MIN_PX.
 *
 * OD-13 (OPEN DECISION — may be descoped): whether a THIRD, even larger
 * "extra-large" density is worth shipping, or whether an OS-level zoom on the
 * Chromium kiosk covers that need, is DEFERRED. It is intentionally NOT built
 * here. If OD-13 is descoped, these two scales are the final answer and nothing
 * downstream should assume a third scale exists. Mirrored in `OPEN_DECISIONS`.
 */
export const DENSITY = {
  normal: {
    captionPx: 16,
    bodyPx: 20,
    headingPx: 28,
    titlePx: 36,
    droPx: 48,
    lineHeight: 1.4,
  },
  largeText: {
    captionPx: 20,
    bodyPx: 24,
    headingPx: 34,
    titlePx: 44,
    droPx: 56,
    lineHeight: 1.35,
  },
} as const satisfies Record<DensityKey, TypeScale>;

/** Default density applied on the first painted frame. */
export const DEFAULT_DENSITY: DensityKey = 'normal';

/**
 * Machine-readable record of design decisions that are intentionally left open.
 * Kept in token metadata (not in `docs/`, which is out of scope for this issue)
 * so the deferral travels with the code that would implement it.
 */
export interface OpenDecision {
  /** Stable decision identifier. */
  readonly id: string;
  /** One-line summary of the choice. */
  readonly summary: string;
  /** Current disposition, e.g. `deferred` or `may-be-descoped`. */
  readonly status: 'deferred' | 'may-be-descoped';
  /** Rationale / what shipping vs. descoping would mean. */
  readonly detail: string;
}

/**
 * Open design decisions carried in token metadata. OD-13 records that a third
 * "extra-large" density is deferred and may be descoped entirely.
 */
export const OPEN_DECISIONS: readonly OpenDecision[] = [
  {
    id: 'OD-13',
    summary: 'A third, extra-large text-density scale beyond normal/largeText.',
    status: 'may-be-descoped',
    detail:
      'The owner may want type even larger than the largeText density. Rather ' +
      'than build a speculative third scale, we ship normal and largeText only. ' +
      'If a bigger option is genuinely needed it may be covered by Chromium ' +
      'kiosk zoom instead of new tokens, so OD-13 is left open and may be ' +
      'descoped without further token work.',
  },
];
