/**
 * Public barrel for the Shapeoko kiosk design tokens.
 *
 * This is the ONE import site downstream screens (#41, #43-#52) use to reach the
 * design system: colours, typography, spacing, and touch-target tokens plus the
 * reusable target-size checker. Re-defining any of these values locally is a
 * defect — the contrast, greyscale, and target-size gates only hold if every
 * screen consumes the tokens from here.
 */

export * from './colors.js';
export * from './typography.js';
export * from './spacing.js';
export * from './targets.js';
