/**
 * Spacing and layout tokens for the Shapeoko kiosk UI.
 *
 * SINGLE SOURCE OF TRUTH for spacing on the FIXED 1024x600 landscape panel.
 * There are deliberately NO responsive breakpoints: the physical panel is
 * 340 x 290 mm carrying one 7" 1024x600 DSI screen in Chromium kiosk mode, so
 * every dimension here is an absolute pixel value tuned for that single layout.
 *
 * Spacing follows a 4 px baseline grid. Touch ergonomics are captured by
 * `MIN_TARGET_PX` (see `targets.ts`, which enforces it): a gloved operator's
 * fingertip needs a generous hit area, hence 72 px — larger than the 44-48 px
 * typical touch minimum.
 */

/** Base grid unit in pixels. All spacing steps are multiples of this. */
export const GRID_BASE_PX = 4;

/**
 * Spacing scale in pixels, on the 4 px baseline grid. Named steps keep call
 * sites readable and prevent ad-hoc pixel literals from creeping into screens.
 */
export const SPACING = {
  /** 4 px — hairline gaps. */
  xs: 4,
  /** 8 px — tight padding. */
  sm: 8,
  /** 12 px — compact padding. */
  smd: 12,
  /** 16 px — default padding/gap. */
  md: 16,
  /** 24 px — comfortable section padding. */
  lg: 24,
  /** 32 px — large gaps between groups. */
  xl: 32,
  /** 48 px — major layout gutters. */
  xxl: 48,
} as const;

/** Union of spacing scale keys. */
export type SpacingKey = keyof typeof SPACING;

/** Corner-radius tokens in pixels. */
export const RADIUS = {
  /** 4 px — subtle rounding. */
  sm: 4,
  /** 8 px — default control/card rounding. */
  md: 8,
  /** 16 px — prominent rounding. */
  lg: 16,
  /** 9999 px — fully rounded (pills). */
  pill: 9999,
} as const;

/** Union of radius token keys. */
export type RadiusKey = keyof typeof RADIUS;

/**
 * Minimum interactive target edge in pixels. A hit area below this on EITHER
 * axis fails the target-size gate in `targets.ts`. Sized up from the usual
 * 44-48 px touch minimum because operators wear gloves. Re-exported here so
 * spacing consumers can reserve room without importing `targets.ts`.
 */
export const MIN_TARGET_PX = 72;

/**
 * Fixed physical/logical dimensions of the one supported panel. These are
 * CONSTANTS, not breakpoints — nothing may branch layout on them at other sizes.
 */
export const SCREEN = {
  /** Logical viewport width in pixels. */
  widthPx: 1024,
  /** Logical viewport height in pixels. */
  heightPx: 600,
  /** Physical panel width in millimetres. */
  panelWidthMm: 340,
  /** Physical panel height in millimetres. */
  panelHeightMm: 290,
  /** Fixed orientation — the panel is mounted landscape. */
  orientation: 'landscape',
} as const;
