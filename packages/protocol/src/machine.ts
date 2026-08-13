/**
 * Machine state contract for the Shapeoko controller.
 *
 * Models the parsed shape of a GRBL 1.1 `?` real-time status report and the
 * associated machine/alarm state, as documented in
 * `docs/research/bitsetter-bitzero-protocol.md`. These are PURE data types and
 * tiny pure helpers only — no serial I/O, no parsing of live reports (that
 * lives in the sender-core GRBL parser, issue #26), no runtime dependencies.
 *
 * The Carbide 3D board runs a closed-source GRBL 1.1 fork over USB serial at
 * 115200. We are a g-code sender + pendant, NOT a motion controller, so these
 * types describe what the firmware reports to us, never what we compute.
 */

/**
 * The nine GRBL 1.1 machine states, exactly as they appear as the first field
 * of a `<...>` status report (e.g. `<Idle|MPos:...>`).
 *
 * `Alarm` is entered on, among others, `ALARM:4` (probe pre-triggered) and
 * `ALARM:5` (probe never contacted). The sender must NEVER auto-issue `$X` to
 * clear an alarm — alarm clearing is an explicit human action (see
 * {@link AlarmCode} and the protocol doc §4).
 */
export const MACHINE_STATES = [
  'Idle',
  'Run',
  'Hold',
  'Jog',
  'Alarm',
  'Door',
  'Check',
  'Home',
  'Sleep',
] as const;

/** A GRBL machine state. */
export type MachineState = (typeof MACHINE_STATES)[number];

/** Type guard: is `value` one of the nine known GRBL machine states? */
export function isMachineState(value: unknown): value is MachineState {
  return typeof value === 'string' && (MACHINE_STATES as readonly string[]).includes(value);
}

/**
 * A 3-axis Cartesian position in millimetres. The Shapeoko Pro XXL is a 3-axis
 * machine (X, Y, Z). Values are always metric because our sender treats
 * physical distances as unit-independent (protocol doc §4.2).
 */
export interface Position {
  x: number;
  y: number;
  z: number;
}

/**
 * The `Pn:` pin-state field of a status report. GRBL only emits `Pn:` when at
 * least one input is active, and each flag is present only when that input is
 * triggered — so every field is optional and its absence means "not active".
 *
 * Pin letters per GRBL 1.1 (`grbl/report.c`):
 *  - `X` / `Y` / `Z` — limit switches
 *  - `P` — probe input (BitSetter / BitZero share this single input via the
 *    Probe Adapter PCB). The sender MUST check {@link PinFlags.probe} before
 *    starting any G38 probe move; a pre-triggered probe yields `ALARM:4`
 *    (protocol doc §4.3).
 *  - `D` — safety door
 *  - `H` — feed hold
 *  - `R` — soft reset
 *  - `S` — cycle start
 */
export interface PinFlags {
  /** `X` limit switch active. */
  limitX?: boolean;
  /** `Y` limit switch active. */
  limitY?: boolean;
  /** `Z` limit switch active. */
  limitZ?: boolean;
  /** `P` probe input active. Check this before any G38 move (doc §4.3). */
  probe?: boolean;
  /** `D` safety door input active. */
  door?: boolean;
  /** `H` feed-hold input active. */
  hold?: boolean;
  /** `R` soft-reset input active. */
  reset?: boolean;
  /** `S` cycle-start input active. */
  cycleStart?: boolean;
}

/**
 * Override percentages from the `Ov:` status field: `Ov:feed,rapid,spindle`.
 * Each is an integer percentage (e.g. `100`).
 */
export interface Overrides {
  feed: number;
  rapid: number;
  spindle: number;
}

/**
 * Accessory state from the `A:` status field. GRBL only emits `A:` when at
 * least one accessory is active; each letter is present only when on, so every
 * field is optional.
 *
 * Letters per GRBL 1.1 (`grbl/report.c`):
 *  - `S` — spindle CW (M3)
 *  - `C` — spindle CCW (M4)
 *  - `F` — flood coolant (M8)
 *  - `M` — mist coolant (M7; compile-time option, may be absent)
 */
export interface AccessoryState {
  /** `S` — spindle running clockwise (M3). */
  spindleCw?: boolean;
  /** `C` — spindle running counter-clockwise (M4). */
  spindleCcw?: boolean;
  /** `F` — flood coolant on (M8). */
  flood?: boolean;
  /** `M` — mist coolant on (M7). */
  mist?: boolean;
}

/**
 * Feed and spindle data from the status report. GRBL emits either `FS:f,s`
 * (feed + spindle) or `F:f` (feed only, when the variable-spindle build option
 * is off), so `spindle` is optional.
 */
export interface FeedSpindle {
  /** Current feed rate (mm/min). */
  feed: number;
  /** Current spindle speed (RPM), when reported. */
  spindle?: number;
}

/**
 * A parsed GRBL 1.1 status report (`<State|...>`).
 *
 * Only {@link StatusReport.state} is guaranteed — every other field is optional
 * because which fields a report carries depends on the firmware's compile-time
 * options, the `$10` status-report mask, and whether the relevant subsystem is
 * currently active. This shape describes the union of fields the Carbide fork
 * MAY send; it does not assert that any given report contains them.
 *
 * Positions: GRBL reports EITHER `MPos:` (machine) with a `WCO:` work-coordinate
 * offset, OR `WPos:` (work) — controlled by `$10`. Both machine and work
 * positions are represented here; a parser derives whichever is absent from
 * `MPos = WPos + WCO`.
 */
export interface StatusReport {
  /** Machine state — always present (first field of the report). */
  state: MachineState;
  /** `MPos:` machine position, when reported. */
  machinePosition?: Position;
  /** `WPos:` work position, when reported. */
  workPosition?: Position;
  /** `WCO:` work-coordinate offset, when reported. */
  workCoordinateOffset?: Position;
  /** `FS:`/`F:` feed and spindle data, when reported. */
  feedSpindle?: FeedSpindle;
  /** `Ov:` feed/rapid/spindle override percentages, when reported. */
  overrides?: Overrides;
  /** `A:` accessory (spindle/coolant) state, when reported. */
  accessories?: AccessoryState;
  /** `Pn:` input pin flags (includes probe `P`), when any input is active. */
  pins?: PinFlags;
  /** `Ln:` line number of the currently executing g-code line, when reported. */
  lineNumber?: number;
  /**
   * `Bf:` planner/RX-buffer state as `Bf:plannerBlocks,rxBytes`, when reported.
   * `rxBytes` relates to the 127-byte usable RX buffer used for character-
   * counting flow control (protocol doc §5.1); the sender's own counter, not
   * this field, is authoritative for streaming.
   */
  buffer?: BufferState;
}

/** `Bf:` buffer-state field: available planner blocks and RX buffer bytes. */
export interface BufferState {
  /** Available planner buffer blocks. */
  plannerBlocks: number;
  /** Available serial RX buffer bytes (of the 128-byte, 127-usable buffer). */
  rxBytes: number;
}

/**
 * Known GRBL 1.1 `ALARM:N` codes, keyed by their numeric code. These are the
 * VERIFIED-from-firmware codes the protocol doc calls out (§4). The map is
 * intentionally partial: the Carbide fork may emit other stock GRBL alarm codes
 * unchanged, so an unknown numeric alarm code must be surfaced to the operator
 * verbatim, never suppressed.
 *
 * SAFETY INVARIANT: the sender must NEVER auto-issue `$X` in response to any of
 * these. Alarm clearing is an explicit human action (protocol doc §4.1, §4.4).
 */
export const ALARM_DESCRIPTIONS: Readonly<Record<number, string>> = {
  1: 'Hard limit triggered. Position lost; re-homing required.',
  2: 'G-code motion target exceeds machine travel (soft limit).',
  3: 'Reset while in motion. Position uncertain; re-homing required.',
  4: 'Probe fail: probe already triggered at start of move (ALARM:4).',
  5: 'Probe fail: probe did not contact within commanded travel (ALARM:5).',
} as const;

/** A GRBL alarm code as reported in `ALARM:N`. */
export type AlarmCode = number;

/**
 * Return a human-readable description for a GRBL alarm code, or `undefined` if
 * the code is not one of the known codes. Pure lookup — callers decide how to
 * present unknown codes (they must still be shown, never swallowed).
 */
export function describeAlarm(code: AlarmCode): string | undefined {
  return ALARM_DESCRIPTIONS[code];
}

/**
 * The two probe-specific alarm codes, named for call sites that guard probing.
 * `PROBE_PRE_TRIGGERED` (4) means the probe was already closed at cycle start;
 * `PROBE_NO_CONTACT` (5) means it never contacted within travel.
 */
export const PROBE_ALARM = {
  PROBE_PRE_TRIGGERED: 4,
  PROBE_NO_CONTACT: 5,
} as const;
