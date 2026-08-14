/**
 * Contrast, greyscale, and typography-floor gates for the design tokens.
 *
 * This test file OWNS the WCAG contrast maths — the utility is implemented here
 * from scratch (not imported from the tokens) so the tokens cannot mark
 * themselves compliant. It then enumerates EVERY approved foreground/background
 * pairing and fails the suite (non-zero exit) if any pair drops below the 7:1
 * floor, if the status palette is not distinguishable in greyscale, if colour is
 * the only signal for a status, or if the typography floors are breached.
 *
 * WCAG 2.x relative luminance is implemented exactly per spec:
 *   channel /= 255; c <= 0.03928 ? c/12.92 : ((c+0.055)/1.055) ** 2.4
 *   L = 0.2126*R + 0.7152*G + 0.0722*B
 *   ratio = (Lmax + 0.05) / (Lmin + 0.05)
 */

import { describe, expect, it } from 'vitest';

import {
  APPROVED_PAIRS,
  INITIAL_STATUS,
  STATUS_ALLOWED_SURFACES,
  STATUS_TOKENS,
  SURFACE,
  type StatusKey,
} from './colors.js';
import {
  BODY_MIN_PX,
  DENSITY,
  DRO_MIN_PX,
  NUMERIC_FONT_FEATURE_SETTINGS,
  NUMERIC_FONT_VARIANT,
  OPEN_DECISIONS,
  type DensityKey,
} from './typography.js';

/** Convert one 8-bit sRGB channel to its linear-light value (WCAG 2.x). */
function channelToLinear(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Parse a `#RRGGBB` string into 8-bit red/green/blue components. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) {
    throw new Error(`Not a #RRGGBB colour: ${hex}`);
  }
  const value = Number.parseInt(match[1] as string, 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

/** WCAG relative luminance of a `#RRGGBB` colour. */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** WCAG contrast ratio between two `#RRGGBB` colours (1..21). */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The contrast floor every approved pairing must clear. */
const CONTRAST_FLOOR = 7;

/** Minimum greyscale luminance separation between adjacent statuses. */
const GREYSCALE_MIN_GAP = 0.03;

describe('WCAG contrast utility (self-implemented)', () => {
  it('computes 21:1 for black on white (reference value)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  });

  it('computes 1:1 for identical colours', () => {
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('is symmetric in its arguments', () => {
    expect(contrastRatio('#0B0D10', '#F2F4F6')).toBeCloseTo(
      contrastRatio('#F2F4F6', '#0B0D10'),
      10,
    );
  });

  it('matches a known mid-grey reference (#777 on white ~= 4.48:1)', () => {
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('rejects malformed colour strings', () => {
    expect(() => contrastRatio('red', '#FFFFFF')).toThrow();
  });
});

describe('approved foreground/background pairings', () => {
  it('enumerates a non-trivial, complete set of pairings', () => {
    // 9 text-on-surface pairs + 10 statuses x 2 surfaces = 29.
    expect(APPROVED_PAIRS.length).toBe(29);
  });

  it.each(APPROVED_PAIRS.map((pair) => [pair.usage, pair] as const))(
    'clears the 7:1 floor: %s',
    (_usage, pair) => {
      const ratio = contrastRatio(pair.foreground, pair.background);
      expect(ratio).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
    },
  );

  it('would fail the gate for a genuinely low-contrast pair', () => {
    // Proves the gate has teeth: a near-invisible pair is far below 7:1.
    expect(contrastRatio('#333333', '#2A2A2A')).toBeLessThan(CONTRAST_FLOOR);
  });
});

describe('status foregrounds are gated OFF overlay surfaces', () => {
  // This block is the machine-enforced form of the canvas/panel-only rule
  // documented on `STATUS_ALLOWED_SURFACES`. It asserts BOTH directions so it
  // cannot rot into a tautology, and it asserts the MEASURED reason so the guard
  // can never silently outlive its own justification: if the palette is ever
  // re-tuned so every status clears 7:1 on `overlay`, the final assertion fails
  // and forces a deliberate revisit of the registry and the allow-list.
  const statusKeys = Object.keys(STATUS_TOKENS) as StatusKey[];
  const statusColors = new Set<string>(statusKeys.map((key) => STATUS_TOKENS[key].color));

  it('lists only canvas and panel as allowed status surfaces (overlay excluded)', () => {
    expect([...STATUS_ALLOWED_SURFACES]).toStrictEqual(['canvas', 'panel']);
    expect(STATUS_ALLOWED_SURFACES).not.toContain('overlay');
  });

  it('approves NO status foreground paired with SURFACE.overlay', () => {
    const statusOnOverlay = APPROVED_PAIRS.filter(
      (pair) => pair.background === SURFACE.overlay && statusColors.has(pair.foreground),
    );
    expect(statusOnOverlay).toStrictEqual([]);
  });

  it('is justified: at least one status genuinely FAILS 7:1 on overlay (alarm ~= 6.28:1)', () => {
    // Measured reason the exclusion exists. `alarm` (#FF7C7C) on SURFACE.overlay
    // computes ~6.28:1 < 7:1. If a re-tune ever makes EVERY status clear 7:1 on
    // overlay, this expectation fails, forcing the allow-list to be widened
    // deliberately rather than by accident.
    const failingOnOverlay = statusKeys.filter(
      (key) => contrastRatio(STATUS_TOKENS[key].color, SURFACE.overlay) < CONTRAST_FLOOR,
    );
    expect(failingOnOverlay).toContain('alarm');
    expect(contrastRatio(STATUS_TOKENS.alarm.color, SURFACE.overlay)).toBeCloseTo(6.28, 2);
  });
});

describe('status palette greyscale distinguishability', () => {
  const statusKeys = Object.keys(STATUS_TOKENS) as StatusKey[];

  it('separates every status by luminance (legible in greyscale)', () => {
    const luminances = statusKeys
      .map((key) => relativeLuminance(STATUS_TOKENS[key].color))
      .sort((a, b) => a - b);
    for (let i = 1; i < luminances.length; i += 1) {
      const previous = luminances[i - 1] as number;
      const current = luminances[i] as number;
      expect(current - previous).toBeGreaterThanOrEqual(GREYSCALE_MIN_GAP);
    }
  });

  it('gives every status a distinct non-colour icon cue', () => {
    const icons = statusKeys.map((key) => STATUS_TOKENS[key].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('gives every status a distinct non-colour shape cue', () => {
    const shapes = statusKeys.map((key) => STATUS_TOKENS[key].shape);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('documents a prose non-colour-cue contract for every status', () => {
    for (const key of statusKeys) {
      expect(STATUS_TOKENS[key].noColorCue.length).toBeGreaterThan(0);
    }
  });
});

describe('first-frame / disconnected presentation', () => {
  it('paints the connection-unknown status first', () => {
    expect(INITIAL_STATUS).toBe('disconnected');
  });

  it('has no default-looking ready palette: the initial status is not idle/run', () => {
    expect(INITIAL_STATUS).not.toBe('idle');
    expect(INITIAL_STATUS).not.toBe('run');
    expect(STATUS_TOKENS.disconnected.color).not.toBe(STATUS_TOKENS.idle.color);
  });

  it('names the emergency-stop state observationally, with no UI action', () => {
    const keys = Object.keys(STATUS_TOKENS);
    expect(keys).toContain('estopObserved');
    // No key implies a client-side stop action.
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain('trigger');
      expect(key.toLowerCase()).not.toContain('button');
    }
  });
});

describe('typography floors', () => {
  const densities = Object.keys(DENSITY) as DensityKey[];

  it('provides both a normal and a LARGE TEXT density scale', () => {
    expect(densities).toContain('normal');
    expect(densities).toContain('largeText');
    expect(densities.length).toBe(2);
  });

  it.each(densities)('keeps body text >= 20px in the %s density', (density) => {
    expect(DENSITY[density].bodyPx).toBeGreaterThanOrEqual(BODY_MIN_PX);
  });

  it.each(densities)('keeps DRO numerals >= 44px in the %s density', (density) => {
    expect(DENSITY[density].droPx).toBeGreaterThanOrEqual(DRO_MIN_PX);
  });

  it('largeText is strictly larger than normal for body and DRO', () => {
    expect(DENSITY.largeText.bodyPx).toBeGreaterThan(DENSITY.normal.bodyPx);
    expect(DENSITY.largeText.droPx).toBeGreaterThan(DENSITY.normal.droPx);
  });

  it('requests tabular + lining numerals for DRO read-outs', () => {
    expect(NUMERIC_FONT_FEATURE_SETTINGS).toContain("'tnum' 1");
    expect(NUMERIC_FONT_FEATURE_SETTINGS).toContain("'lnum' 1");
    expect(NUMERIC_FONT_VARIANT).toContain('tabular-nums');
    expect(NUMERIC_FONT_VARIANT).toContain('lining-nums');
  });
});

describe('open design decisions', () => {
  it('records OD-13 as an open decision that may be descoped', () => {
    const od13 = OPEN_DECISIONS.find((decision) => decision.id === 'OD-13');
    expect(od13).toBeDefined();
    expect(od13?.status).toBe('may-be-descoped');
    expect(od13?.detail.length ?? 0).toBeGreaterThan(0);
  });
});
