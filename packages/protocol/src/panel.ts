/**
 * ESP32 operator-panel contract for the Shapeoko controller.
 *
 * Types for the logical events exchanged with the ESP32 pendant panel: axis
 * selector, step multiplier, button presses, and LED state. Control identifiers
 * (button ids, LED ids) and the axis/step values are taken from the canonical
 * machine-readable panel spec `hardware/panel-spec.yaml` (Wave 1) — they are
 * verified against that source of truth, not invented here.
 *
 * PURE data + helpers only — no I/O, no firmware frame encoding. The on-the-wire
 * byte layout of panel frames belongs to a later ESP32 firmware issue (see the
 * seam on {@link PanelFrame}); these types describe the LOGICAL messages, so the
 * transport can change without touching consumers.
 */

/**
 * Axis selector positions, from `hardware/panel-spec.yaml` control `axis_select`
 * ("Axis selector OFF / X / Y / Z"). `OFF` means no axis is selected and jogging
 * from the panel is disabled.
 */
export const AXIS_SELECTORS = ['OFF', 'X', 'Y', 'Z'] as const;

/** A panel axis-selector position. */
export type AxisSelector = (typeof AXIS_SELECTORS)[number];

/**
 * Step-multiplier detents, from `hardware/panel-spec.yaml` control `step_select`
 * ("Step multiplier x1 / x10 / x100 (0.001 / 0.01 / 0.1 mm)"). The multiplier is
 * the labelled dial value; {@link STEP_MULTIPLIER_MM} maps it to a jog distance.
 */
export const STEP_MULTIPLIERS = [1, 10, 100] as const;

/** A panel step multiplier (x1 / x10 / x100). */
export type StepMultiplier = (typeof STEP_MULTIPLIERS)[number];

/**
 * Jog distance in millimetres for each step multiplier, per the panel brief and
 * the `step_select` dial legend: `1 -> 0.001 mm`, `10 -> 0.01 mm`,
 * `100 -> 0.1 mm`. Typed as an exact mapping so the values are checked at
 * compile time.
 */
export const STEP_MULTIPLIER_MM: Readonly<Record<StepMultiplier, number>> = {
  1: 0.001,
  10: 0.01,
  100: 0.1,
} as const;

/**
 * Convert a step multiplier to its jog distance in millimetres. Total-function
 * pure lookup over the closed {@link StepMultiplier} set.
 */
export function stepMultiplierToMillimeters(step: StepMultiplier): number {
  return STEP_MULTIPLIER_MM[step];
}

/**
 * Panel button identifiers, verbatim from the `controls` ids in
 * `hardware/panel-spec.yaml`. These are the buttons the ESP32 can report as
 * pressed.
 *
 * Note `estop`: software only OBSERVES the emergency stop, it never commands it
 * (panel spec `estop.notes`, issue #115). It is included so the panel can report
 * E-stop state to the host, not so the host can actuate it.
 */
export const PANEL_BUTTONS = [
  'estop',
  'start',
  'hold',
  'reset',
  'enable',
  'spindle',
  'dust',
] as const;

/** A panel button id. */
export type PanelButtonId = (typeof PANEL_BUTTONS)[number];

/**
 * Panel LED (status indicator) identifiers, verbatim from the `led_indicator`
 * controls in `hardware/panel-spec.yaml`.
 */
export const PANEL_LEDS = ['led_pwr', 'led_link', 'led_homed', 'led_alarm', 'led_probe'] as const;

/** A panel LED id. */
export type PanelLedId = (typeof PANEL_LEDS)[number];

/** LED drive state the host commands for a panel indicator. */
export type LedState = 'off' | 'on' | 'blink';

/**
 * Button transition reported by the panel. Momentary buttons report both edges;
 * the deadman (`enable`) in particular must report release so the host can stop
 * jogging.
 */
export type ButtonEdge = 'down' | 'up';

/**
 * Discriminant for a panel frame's direction/kind. Frames are a discriminated
 * union on {@link PanelFrame.type}.
 *
 * Inbound (panel -> host): `button`, `axis`, `step`, `mpg`, `pot`.
 * Outbound (host -> panel): `led`.
 */
export type PanelFrameType = 'button' | 'axis' | 'step' | 'mpg' | 'pot' | 'led';

/** Panel -> host: a button changed state. */
export interface PanelButtonFrame {
  type: 'button';
  button: PanelButtonId;
  edge: ButtonEdge;
}

/** Panel -> host: the axis selector moved to a new position. */
export interface PanelAxisFrame {
  type: 'axis';
  axis: AxisSelector;
}

/** Panel -> host: the step-multiplier dial moved to a new detent. */
export interface PanelStepFrame {
  type: 'step';
  step: StepMultiplier;
}

/**
 * Panel -> host: MPG handwheel motion, as a signed detent delta since the last
 * frame (positive = clockwise). The host multiplies by the current
 * {@link StepMultiplier} distance and the selected {@link AxisSelector} to build
 * a `$J=` jog (protocol doc §5.3); cancellation with `0x85` is the host's job,
 * not encoded here.
 */
export interface PanelMpgFrame {
  type: 'mpg';
  /** Signed number of encoder detents since the previous frame. */
  delta: number;
}

/**
 * Panel -> host: an analog potentiometer changed. Covers the feed-override,
 * spindle-override, etc. pots. `value` is normalised `0..1`; mapping to a GRBL
 * override percentage is the host's responsibility.
 */
export interface PanelPotFrame {
  type: 'pot';
  /** Pot control id from the panel spec (e.g. `feed_override`, `spindle_ovr`). */
  pot: string;
  /** Normalised position, `0..1`. */
  value: number;
}

/** Host -> panel: set an indicator LED's drive state. */
export interface PanelLedFrame {
  type: 'led';
  led: PanelLedId;
  state: LedState;
}

/**
 * The panel logical-frame discriminated union, keyed on `type`.
 *
 * UNVERIFIED (firmware, out of scope for #13): the on-the-wire byte encoding of
 * these frames — framing bytes, field order, checksum, endianness — is NOT
 * defined here. That is the seam: this union is the stable LOGICAL contract, and
 * a later ESP32 firmware/frame-encoding issue owns serialising it. Consumers
 * depend on these object shapes, never on wire bytes, so the encoding can be
 * settled against real hardware without changing this contract.
 */
export type PanelFrame =
  | PanelButtonFrame
  | PanelAxisFrame
  | PanelStepFrame
  | PanelMpgFrame
  | PanelPotFrame
  | PanelLedFrame;
