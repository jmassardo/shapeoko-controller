/**
 * ESP32 operator-panel contract for the Shapeoko controller.
 *
 * Types for the logical events exchanged with the ESP32 pendant panel: axis
 * selector, step multiplier, button presses, and LED state. Control identifiers
 * (button ids, LED ids) and the axis/step values are taken from the canonical
 * machine-readable panel spec `hardware/panel-spec.yaml` (Wave 1) — they are
 * verified against that source of truth, not invented here.
 *
 * PURE data + helpers only — no I/O, no firmware frame encoding. The LOGICAL
 * messages ({@link PanelFrame}) are transport-independent; consumers depend on
 * these object shapes, never on wire bytes.
 *
 * The on-the-wire byte ENVELOPE (SYNC anchor, LEN/TYPE/SEQ header, CRC-16) is now
 * defined and normative in the ESP32 firmware header
 * `firmware/panel/include/frame_types.h` (issue #54), with the matching Pi-side
 * codec in `@shapeoko/sender-core` (issue #55). The stable envelope constants and
 * message-type values are re-published at the bottom of this file (see
 * {@link PanelMessageType}) as an INDEPENDENT public mirror, so packages outside
 * sender-core can consume panel wire types without importing sender-core
 * internals. That mirror carries constants and type declarations ONLY — this
 * package stays pure, so no codec logic lives here. A drift guard in sender-core
 * asserts this mirror stays byte-for-byte in step with #54.
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
 * The on-the-wire byte ENVELOPE that carries these logical frames — SYNC anchor,
 * LEN/TYPE/SEQ header, CRC-16, endianness — was previously an out-of-scope seam
 * (originally deferred by #13). That seam is now CLOSED: the envelope is defined
 * and normative in `firmware/panel/include/frame_types.h` (#54), with the Pi-side
 * codec in `@shapeoko/sender-core` and the public wire mirror at the bottom of
 * this file ({@link PanelMessageType} and the `PANEL_WIRE_*` constants). This
 * union remains the stable, transport-INDEPENDENT logical contract: it describes
 * WHAT a panel message means, while the wire mirror describes HOW an envelope is
 * framed. The two are intentionally separate — a consumer that only cares about
 * logical intent depends on this union and never on wire bytes.
 */
export type PanelFrame =
  | PanelButtonFrame
  | PanelAxisFrame
  | PanelStepFrame
  | PanelMpgFrame
  | PanelPotFrame
  | PanelLedFrame;

// -----------------------------------------------------------------------------
// PUBLIC WIRE MIRROR — panel frame ENVELOPE constants and message types.
// -----------------------------------------------------------------------------
//
// NORMATIVE SOURCE: `firmware/panel/include/frame_types.h` (issue #54). These
// declarations are an INDEPENDENT public mirror of the stable wire envelope so
// packages outside `@shapeoko/sender-core` can name panel wire types without
// importing sender-core internals. This is deliberate duplication of the
// self-contained mirror in `packages/sender-core/src/panel/frameTypes.ts` (this
// monorepo has no cross-package imports this wave). Both mirrors are held in
// step with #54 by the drift guard in
// `packages/sender-core/src/panel/frameTypes.test.ts`, which reads the C header
// AND both TypeScript mirrors as text and fails loudly on any divergence.
//
// Constants and TYPE DECLARATIONS ONLY — no codec logic (CRC, encode/decode)
// lives here, because `@shapeoko/protocol` is intentionally pure. The codec is
// `@shapeoko/sender-core`'s job.
//
// These names are prefixed `PANEL_WIRE_*` / `PanelMessageType` to stand clearly
// apart from the LOGICAL {@link PanelFrame} union and {@link PanelFrameType}
// above: those model message MEANING, these model the transport ENVELOPE.

/** First SYNC anchor byte (`kSync0` in #54). */
export const PANEL_WIRE_SYNC0 = 0xaa;

/** Second SYNC anchor byte (`kSync1` in #54), distinct from SYNC0. */
export const PANEL_WIRE_SYNC1 = 0x55;

/** Maximum payload length in bytes (`kMaxPayloadLen` in #54). */
export const PANEL_WIRE_MAX_PAYLOAD_LEN = 64;

/** Fixed framing overhead in bytes (`kFrameOverhead` in #54): SYNC0, SYNC1, LEN,
 *  TYPE, SEQ, CRC_HI, CRC_LO. A complete frame is this plus LEN. */
export const PANEL_WIRE_FRAME_OVERHEAD = 7;

/** Smallest complete frame, LEN = 0 (`kMinFrameLen` in #54). */
export const PANEL_WIRE_MIN_FRAME_LEN = PANEL_WIRE_FRAME_OVERHEAD; // 7

/** Largest complete frame, LEN = 64 (`kMaxFrameLen` in #54). */
export const PANEL_WIRE_MAX_FRAME_LEN = PANEL_WIRE_FRAME_OVERHEAD + PANEL_WIRE_MAX_PAYLOAD_LEN; // 71

/**
 * The normative TYPE field values, byte-for-byte from #54's
 * `enum class MessageType : uint8_t`. A `const` object + union type (not a TS
 * `enum`) to stay erasable under this package's `isolatedModules` /
 * `verbatimModuleSyntax` settings.
 */
export const PanelMessageType = {
  /** panel -> Pi : link handshake, empty payload. */
  Hello: 0x00,
  /** panel -> Pi : firmware version, boot count, capabilities. */
  Info: 0x01,
  /** panel -> Pi : periodic control state; payload opaque to the codec. */
  Status: 0x02,
  /** panel -> Pi : PRIORITY safety events (deadman/E-stop). */
  Event: 0x03,
  /** Pi -> panel : LED patterns, dust mode. */
  Cmd: 0x04,
  /** either way : acknowledgement of a received frame. */
  Ack: 0x05,
} as const;

/** A panel message type byte (one of the {@link PanelMessageType} values). */
export type PanelMessageType = (typeof PanelMessageType)[keyof typeof PanelMessageType];
