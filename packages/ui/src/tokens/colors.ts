/**
 * Colour tokens for the Shapeoko kiosk UI.
 *
 * This module is the SINGLE SOURCE OF TRUTH for every colour the 7" 1024x600
 * DSI kiosk paints. Screens added in later issues (#41, #43-#52) must consume
 * these tokens rather than re-defining hex literals locally, so that the
 * contrast and greyscale-distinguishability gates in `contrast.test.ts` stay
 * meaningful across the whole app.
 *
 * WHY a dark, high-luminance palette: a workshop next to a running spindle is a
 * high-glare, dusty environment viewed at arm's length, sometimes through safety
 * glasses. Near-black surfaces with high-luminance foregrounds make the WCAG
 * >= 7:1 contrast floor easy to clear HONESTLY (every pair below is measured,
 * not hoped for) and keep the panel from acting as a light source in a dim shop.
 *
 * WHY colour is never the only signal: an operator may be colour-blind, or the
 * panel may be washed out by sunlight. Every semantic status therefore carries
 * a non-colour cue (an `icon` glyph AND a badge `shape`) and a deliberately
 * SEPARATED greyscale luminance, so the same information survives a monochrome
 * render. See `STATUS_TOKENS` below and the greyscale assertions in the tests.
 *
 * SAFETY FRAMING (critical): this UI is an OBSERVER, not a safety device. Token
 * names may describe machine states the UI MIRRORS from GRBL, but they must not
 * imply any client-side check prevents motion. In particular the emergency-stop
 * token is named `estopObserved` — it describes a mirrored, observed condition
 * and deliberately names no UI stop action.
 */

/**
 * Surface (background) tokens, darkest to lightest. `canvas` is the root kiosk
 * background painted on the very first frame; `panel` and `overlay` are raised
 * containers layered on top of it.
 */
export const SURFACE = {
  /** Root kiosk background — painted before any socket/serial connection. */
  canvas: '#0B0D10',
  /** Raised container / card surface. */
  panel: '#15181C',
  /** Highest elevation surface (menus, dialogs, transient overlays). */
  overlay: '#1F2429',
} as const;

/** Union of surface token keys. */
export type SurfaceKey = keyof typeof SURFACE;

/**
 * Foreground text tokens. `disabled` is intentionally bright enough to still
 * clear >= 7:1 on every surface: a disabled control must remain READABLE (not
 * just measurable) so a gloved operator can identify why it is inactive.
 */
export const TEXT = {
  /** Primary body and heading text. */
  primary: '#F2F4F6',
  /** Secondary / supporting text. */
  secondary: '#C7CDD3',
  /** Disabled-control text — still >= 7:1 on every surface by design. */
  disabled: '#AAB2BA',
} as const;

/** Union of foreground text token keys. */
export type TextKey = keyof typeof TEXT;

/**
 * The set of machine states this UI mirrors from GRBL, plus a
 * connection-unknown state and an OBSERVED emergency-stop state. This is a
 * closed union so downstream screens can exhaustively switch on it.
 */
export type StatusKey =
  | 'disconnected'
  | 'idle'
  | 'run'
  | 'hold'
  | 'jog'
  | 'home'
  | 'probe'
  | 'alarm'
  | 'door'
  | 'estopObserved';

/**
 * Badge outline shapes used as a NON-COLOUR cue. Every status uses a distinct
 * shape so the palette is distinguishable without relying on hue.
 */
export type StatusShape =
  | 'dashed-ring'
  | 'circle'
  | 'triangle'
  | 'square'
  | 'diamond'
  | 'pentagon'
  | 'crosshair'
  | 'octagon'
  | 'chevron'
  | 'hexagon';

/**
 * Metadata describing one semantic status. The `color` is the foreground the
 * status paints on `SURFACE.canvas`/`SURFACE.panel`; the `icon` and `shape`
 * are the non-colour cues that make the status legible in greyscale or to a
 * colour-blind operator. `noColorCue` documents, in prose, the contract that
 * colour is never the only signal.
 */
export interface StatusToken {
  /** Human-readable state label rendered in the UI. */
  readonly label: string;
  /** Foreground colour token (>= 7:1 on canvas and panel — verified in tests). */
  readonly color: string;
  /** Named glyph cue, independent of colour. */
  readonly icon: string;
  /** Badge outline shape cue, independent of colour. */
  readonly shape: StatusShape;
  /** Prose statement of the non-colour cue so intent survives refactors. */
  readonly noColorCue: string;
}

/**
 * Semantic status palette. Foreground colours were chosen so that their
 * relative luminances are SEPARATED (see the greyscale assertions in
 * `contrast.test.ts`), which means the palette is legible even rendered in
 * pure greyscale — before you add the per-status icon and shape.
 *
 * `disconnected` is the connection-unknown presentation used for the first
 * painted frame. It reads as a distinct, unmistakably "not connected" state:
 * there is deliberately NO default-looking "ready/idle" palette shown before a
 * socket or serial link exists (see `INITIAL_STATUS`).
 */
export const STATUS_TOKENS = {
  disconnected: {
    label: 'DISCONNECTED / UNKNOWN',
    color: '#A5AFB8',
    icon: 'link-slash',
    shape: 'dashed-ring',
    noColorCue: 'Slashed-link glyph inside a dashed ring; neutral desaturated grey.',
  },
  idle: {
    label: 'IDLE',
    color: '#43EDDE',
    icon: 'circle-dot',
    shape: 'circle',
    noColorCue: 'Filled centre-dot glyph inside a solid circle.',
  },
  run: {
    label: 'RUN',
    color: '#5EFA7D',
    icon: 'play',
    shape: 'triangle',
    noColorCue: 'Play glyph inside an upward triangle.',
  },
  hold: {
    label: 'HOLD',
    color: '#FFEC51',
    icon: 'pause',
    shape: 'square',
    noColorCue: 'Pause glyph inside a square.',
  },
  jog: {
    label: 'JOG',
    color: '#89CFFF',
    icon: 'arrows-move',
    shape: 'diamond',
    noColorCue: 'Four-way move arrows inside a diamond.',
  },
  home: {
    label: 'HOME',
    color: '#F6BAFF',
    icon: 'house',
    shape: 'pentagon',
    noColorCue: 'House glyph inside a pentagon.',
  },
  probe: {
    label: 'PROBE',
    color: '#5BF9FF',
    icon: 'crosshair',
    shape: 'crosshair',
    noColorCue: 'Crosshair glyph inside a crosshair frame.',
  },
  alarm: {
    label: 'ALARM',
    color: '#FF7C7C',
    icon: 'triangle-exclamation',
    shape: 'octagon',
    noColorCue: 'Exclamation glyph inside an octagon.',
  },
  door: {
    label: 'DOOR',
    color: '#FFAE44',
    icon: 'door-open',
    shape: 'chevron',
    noColorCue: 'Open-door glyph inside a chevron.',
  },
  estopObserved: {
    // OBSERVATIONAL ONLY. This mirrors an emergency-stop condition reported by
    // the machine. It names NO UI action and must never be wired to trigger a
    // stop — the physical E-stop is the only emergency-stop control.
    label: 'E-STOP (observed)',
    color: '#FF9D88',
    icon: 'hand',
    shape: 'hexagon',
    noColorCue: 'Raised-hand glyph inside a hexagon.',
  },
} as const satisfies Record<StatusKey, StatusToken>;

/**
 * The status presented on the very first painted frame, before any socket or
 * serial connection exists. Intentionally the connection-unknown state so the
 * kiosk never shows a reassuring "ready" palette it has not earned.
 */
export const INITIAL_STATUS: StatusKey = 'disconnected';

/**
 * One approved foreground/background pairing. Only pairings enumerated here are
 * sanctioned for use together, and `contrast.test.ts` asserts EVERY one clears
 * the >= 7:1 floor. Adding a pairing that fails makes the suite exit non-zero.
 */
export interface ColorPair {
  /** Foreground hex colour. */
  readonly foreground: string;
  /** Background hex colour. */
  readonly background: string;
  /** What the pairing is used for (kept for auditability). */
  readonly usage: string;
}

/**
 * The surfaces a status foreground may LEGALLY sit on, in registry order. This
 * readonly tuple is the SINGLE SOURCE OF TRUTH that drives the status half of
 * `APPROVED_PAIRS` (via `statusPairsOn`), so the approved registry and this rule
 * can never drift apart: widening the rule means editing this tuple, which
 * immediately widens the pairs the contrast gate measures.
 *
 * WHY `overlay` is deliberately EXCLUDED: the current status palette does not
 * clear the >= 7:1 contrast floor against `SURFACE.overlay`. The `alarm`
 * foreground (`#FF7C7C`) measures ~6.28:1 there — below 7:1. Status badges must
 * therefore NOT be placed on overlay surfaces (menus, dialogs, transient
 * overlays) until the status palette is re-tuned to clear 7:1 on `overlay`.
 *
 * This is not a matter of reviewer memory: the negative guard in
 * `contrast.test.ts` fails the suite if `overlay` is added here or if any status
 * foreground is paired with `overlay` in the registry, AND it fails if the
 * palette is ever re-tuned so every status DOES clear 7:1 on `overlay` (forcing
 * a deliberate revisit of this restriction).
 */
export const STATUS_ALLOWED_SURFACES = ['canvas', 'panel'] as const satisfies readonly SurfaceKey[];

/** Union of the surface keys a status foreground may legally sit on. */
export type StatusSurfaceKey = (typeof STATUS_ALLOWED_SURFACES)[number];

/** Build the approved status-on-surface pairs for one allowed background surface. */
function statusPairsOn(surfaceName: StatusSurfaceKey): ColorPair[] {
  return (Object.keys(STATUS_TOKENS) as StatusKey[]).map((key) => ({
    foreground: STATUS_TOKENS[key].color,
    background: SURFACE[surfaceName],
    usage: `${key} status on ${surfaceName}`,
  }));
}

/**
 * Every approved foreground/background pairing in the design system, enumerated
 * exhaustively. Text tokens are approved on every surface; each status colour is
 * approved only on the surfaces listed in `STATUS_ALLOWED_SURFACES` (`canvas`
 * and `panel` — the two surfaces a status badge may sit on; `overlay` is
 * excluded, see that tuple for why).
 */
export const APPROVED_PAIRS: readonly ColorPair[] = [
  // Body/primary text on every surface.
  { foreground: TEXT.primary, background: SURFACE.canvas, usage: 'primary text on canvas' },
  { foreground: TEXT.primary, background: SURFACE.panel, usage: 'primary text on panel' },
  { foreground: TEXT.primary, background: SURFACE.overlay, usage: 'primary text on overlay' },
  // Secondary text on every surface.
  { foreground: TEXT.secondary, background: SURFACE.canvas, usage: 'secondary text on canvas' },
  { foreground: TEXT.secondary, background: SURFACE.panel, usage: 'secondary text on panel' },
  { foreground: TEXT.secondary, background: SURFACE.overlay, usage: 'secondary text on overlay' },
  // Disabled text on every surface — must remain readable, not just measurable.
  { foreground: TEXT.disabled, background: SURFACE.canvas, usage: 'disabled text on canvas' },
  { foreground: TEXT.disabled, background: SURFACE.panel, usage: 'disabled text on panel' },
  { foreground: TEXT.disabled, background: SURFACE.overlay, usage: 'disabled text on overlay' },
  // Every status foreground on each allowed surface (canvas and panel only).
  ...STATUS_ALLOWED_SURFACES.flatMap((surfaceName) => statusPairsOn(surfaceName)),
];
