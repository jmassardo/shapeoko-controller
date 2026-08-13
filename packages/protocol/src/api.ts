/**
 * WebSocket API contract for the Shapeoko controller.
 *
 * The command/event message types that cross the WebSocket boundary between the
 * sender backend and the kiosk UI (and, relayed, the ESP32 panel). Every message
 * is a DISCRIMINATED UNION on its `type` field and carries only plain data — no
 * workspace-specific implementation classes, no I/O, no runtime dependencies.
 *
 * This file defines the SHAPE of the contract. Actual transport, the GRBL serial
 * state machine, streaming/flow-control, and probing sequences live in
 * sender-core and later issues. Behavioural invariants from
 * `docs/research/bitsetter-bitzero-protocol.md` are noted where they constrain a
 * message's meaning, but this package enforces none of them at runtime.
 */

import type { AlarmCode, StatusReport } from './machine.js';
import type { GrblSettings } from './settings.js';
import type { AxisSelector, PanelFrame, StepMultiplier } from './panel.js';

/**
 * GRBL real-time command bytes (protocol doc §5.2). These are single bytes
 * intercepted by GRBL before the RX buffer, so they bypass character-counting
 * flow control. Named here so a {@link RealtimeCommand} message references a
 * name, not a magic number.
 *
 * `SOFT_RESET` (0x18) and jog-cancel `JOG_CANCEL` (0x85) are the two the pendant
 * uses most; the override bytes trim feed/spindle live. `$X` alarm-unlock is
 * deliberately NOT a real-time byte and NOT in this list — see
 * {@link UnlockAlarmCommand}.
 */
export const REALTIME_COMMAND = {
  STATUS_REPORT: 0x3f,
  FEED_HOLD: 0x21,
  CYCLE_START: 0x7e,
  SOFT_RESET: 0x18,
  JOG_CANCEL: 0x85,
  SAFETY_DOOR: 0x84,
  FEED_OVERRIDE_RESET: 0x90,
  FEED_OVERRIDE_PLUS_10: 0x91,
  FEED_OVERRIDE_MINUS_10: 0x92,
  FEED_OVERRIDE_PLUS_1: 0x93,
  FEED_OVERRIDE_MINUS_1: 0x94,
  RAPID_OVERRIDE_RESET: 0x95,
  RAPID_OVERRIDE_50: 0x96,
  RAPID_OVERRIDE_25: 0x97,
  SPINDLE_OVERRIDE_RESET: 0x99,
  SPINDLE_OVERRIDE_PLUS_10: 0x9a,
  SPINDLE_OVERRIDE_MINUS_10: 0x9b,
  SPINDLE_OVERRIDE_PLUS_1: 0x9c,
  SPINDLE_OVERRIDE_MINUS_1: 0x9d,
  TOGGLE_SPINDLE_STOP: 0x9e,
  TOGGLE_FLOOD_COOLANT: 0xa0,
  TOGGLE_MIST_COOLANT: 0xa1,
} as const;

/** The name of a known real-time command byte. */
export type RealtimeCommandName = keyof typeof REALTIME_COMMAND;

/**
 * Connection lifecycle state reported to the UI. Distinct from
 * {@link StatusReport.state} (the GRBL machine state): this is about the serial
 * link, not the mill.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Severity for a {@link LogEvent} line. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// Commands: UI -> sender.
// ---------------------------------------------------------------------------

/** Open the serial connection to the controller. */
export interface ConnectCommand {
  type: 'connect';
  /** Serial device path, e.g. `/dev/ttyUSB0`. */
  port: string;
  /** Baud rate; the Carbide board runs 115200. */
  baudRate?: number;
}

/** Close the serial connection. */
export interface DisconnectCommand {
  type: 'disconnect';
}

/**
 * Send one line of g-code. This is a single interactive line (MDI), not file
 * streaming — use {@link StreamStartCommand} for a program. The trailing newline
 * is the sender's responsibility.
 */
export interface SendLineCommand {
  type: 'sendLine';
  line: string;
}

/**
 * Send a GRBL real-time command byte (§5.2). Referenced by name; the sender maps
 * it to the raw byte in {@link REALTIME_COMMAND}.
 */
export interface RealtimeCommand {
  type: 'realtime';
  command: RealtimeCommandName;
}

/**
 * Jog request. The sender formats this as `$J=G91 G21 <axis><distance> F<feed>`
 * (protocol doc §5.3) — always incremental (`G91`), always metric (`G21`). Jog
 * motion is cancelled with the `JOG_CANCEL` (0x85) real-time command via
 * {@link RealtimeCommand}, NEVER with `G92` and never by any work-offset change.
 */
export interface JogCommand {
  type: 'jog';
  axis: JogAxis;
  /** Signed jog distance in millimetres (sign selects direction). */
  distanceMm: number;
  /** Feed rate in mm/min; required in every jog command (not modal). */
  feedMmPerMin: number;
}

/** Convenience alias for a jog-able axis (the axis selector without `OFF`). */
export type JogAxis = Exclude<AxisSelector, 'OFF'>;

/** Start streaming a g-code program. */
export interface StreamStartCommand {
  type: 'streamStart';
  /** Ordered g-code lines to stream (comments/blanks may be included). */
  lines: readonly string[];
  /** Optional job name for progress/telemetry display. */
  name?: string;
}

/** Feed-hold a running stream (maps to the `!` real-time command). */
export interface StreamPauseCommand {
  type: 'streamPause';
}

/** Resume a paused stream (maps to the `~` real-time command). */
export interface StreamResumeCommand {
  type: 'streamResume';
}

/** Abort the current stream (soft reset; program will not resume mid-file). */
export interface StreamStopCommand {
  type: 'streamStop';
}

/** Run the homing cycle (`$H`). */
export interface HomeCommand {
  type: 'home';
}

/**
 * Clear an alarm with `$X` (unlock without homing).
 *
 * SAFETY SEAM: this command exists ONLY so an explicit human action in the UI
 * can request it. The sender must NEVER auto-issue `$X` in response to an alarm
 * (protocol doc §4.1, §4.4). Position may be uncertain after unlock, so the UI
 * is responsible for gating this behind an explicit operator confirmation.
 */
export interface UnlockAlarmCommand {
  type: 'unlockAlarm';
}

/**
 * Set a work-coordinate offset. The sender applies this with `G10 L20 P0`
 * (protocol doc §2.4) — NEVER `G92`. Omitted axes are left unchanged.
 */
export interface SetWorkOffsetCommand {
  type: 'setWorkOffset';
  x?: number;
  y?: number;
  z?: number;
}

/** Request the cached/fresh `$$` settings block. */
export interface GetSettingsCommand {
  type: 'getSettings';
}

/** The UI -> sender command union, discriminated on `type`. */
export type ClientCommand =
  | ConnectCommand
  | DisconnectCommand
  | SendLineCommand
  | RealtimeCommand
  | JogCommand
  | StreamStartCommand
  | StreamPauseCommand
  | StreamResumeCommand
  | StreamStopCommand
  | HomeCommand
  | UnlockAlarmCommand
  | SetWorkOffsetCommand
  | GetSettingsCommand;

// ---------------------------------------------------------------------------
// Events: sender -> UI.
// ---------------------------------------------------------------------------

/** Serial connection state changed. */
export interface ConnectionEvent {
  type: 'connection';
  state: ConnectionState;
  /** Human-readable detail (e.g. the error message when `state` is `error`). */
  detail?: string;
}

/** The GRBL welcome string seen after connect/reset. */
export interface WelcomeEvent {
  type: 'welcome';
  /**
   * Raw welcome line as received.
   *
   * UNVERIFIED (#16): the exact welcome string and `$I` build-info content of
   * the Carbide fork are undocumented (the source is unavailable). This is the
   * seam — the raw line is passed through verbatim rather than parsed into a
   * fixed shape, so identifying "Carbide"/"CM" or a version is done downstream
   * once #16 captures real strings from hardware. Do not hard-code an expected
   * welcome format against this field.
   */
  line: string;
}

/** A parsed status report (`<...>`). */
export interface StatusEvent {
  type: 'status';
  report: StatusReport;
}

/**
 * An `ALARM:N` was reported. The description (if known) comes from
 * {@link AlarmCode} lookups. The UI must surface this and require an explicit
 * human action to clear it — the sender never clears it automatically.
 */
export interface AlarmEvent {
  type: 'alarm';
  code: AlarmCode;
  /** Known description, when the code is recognised. */
  message?: string;
}

/** An `error:N` response to a command. */
export interface ErrorEvent {
  type: 'error';
  code: number;
  message?: string;
}

/** An `ok` acknowledgement from GRBL. */
export interface OkEvent {
  type: 'ok';
}

/** The `$$` settings block was read. */
export interface SettingsEvent {
  type: 'settings';
  settings: GrblSettings;
}

/**
 * Result of a probe cycle (`$#` -> `[PRB:x,y,z:success]`). `success` reflects the
 * trailing `:1`/`:0`. On a failed G38.2, expect an accompanying
 * {@link AlarmEvent} (`ALARM:5`) as well (protocol doc §4.1).
 */
export interface ProbeResultEvent {
  type: 'probeResult';
  success: boolean;
  x: number;
  y: number;
  z: number;
}

/** Progress of an in-flight stream. */
export interface StreamProgressEvent {
  type: 'streamProgress';
  /** Lines sent so far. */
  sent: number;
  /** Total lines in the program. */
  total: number;
  /** Current stream lifecycle phase. */
  phase: 'running' | 'paused' | 'completed' | 'stopped';
}

/** A diagnostic/log line for display. */
export interface LogEvent {
  type: 'log';
  level: LogLevel;
  message: string;
}

/**
 * A frame relayed to/from the ESP32 panel over the same WebSocket. Wraps the
 * logical {@link PanelFrame}; wire encoding of the frame itself is out of scope
 * (see the seam on `PanelFrame`).
 */
export interface PanelEvent {
  type: 'panel';
  frame: PanelFrame;
}

/** The sender -> UI event union, discriminated on `type`. */
export type ServerEvent =
  | ConnectionEvent
  | WelcomeEvent
  | StatusEvent
  | AlarmEvent
  | ErrorEvent
  | OkEvent
  | SettingsEvent
  | ProbeResultEvent
  | StreamProgressEvent
  | LogEvent
  | PanelEvent;

/** Any message crossing the WebSocket, in either direction. */
export type ProtocolMessage = ClientCommand | ServerEvent;

/**
 * Re-exported for convenience so a jog consumer can pair an axis with a step
 * without importing from `panel.js` separately.
 */
export type { StepMultiplier };
