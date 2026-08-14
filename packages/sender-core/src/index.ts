/**
 * @shapeoko/sender-core — g-code sender core for the Shapeoko controller.
 *
 * This package now owns the typed serial transport layer: a strongly-typed
 * contract ({@link SerialTransport}) with a real `serialport`-backed
 * implementation ({@link SerialPortTransport}) and a deterministic in-memory
 * double ({@link FakeTransport}) for tests. Layered on top of the transport, the
 * GRBL line codec ({@link GrblLineCodec}) has now landed: it frames the raw byte
 * stream into typed {@link GrblLineEvent}s (`ok`, `error`, `ALARM`, bracket
 * messages, settings, welcome, and raw status reports). The remaining
 * higher-level concerns — port discovery, status-report field parsing,
 * real-time prioritization, and G-code streaming flow control — are layered on
 * in later issues. This is explicitly NOT CNCjs.
 */

export type {
  SerialTransport,
  SerialTransportEventMap,
  SerialErrorKind,
  SerialPortLike,
  SerialPortFactory,
  SerialPortOpenOptions,
} from './serial/types.js';
export { SerialTransportError } from './serial/types.js';
export { SerialPortTransport, defaultSerialPortFactory } from './serial/transport.js';
export { FakeTransport, type ExpectedWrite } from './serial/fakeTransport.js';

export { GrblLineCodec, GRBL_ALARM_DESCRIPTIONS, describeAlarm } from './grbl/lineCodec.js';
export type {
  GrblLineEvent,
  GrblOkEvent,
  GrblErrorEvent,
  GrblAlarmEvent,
  GrblMessageEvent,
  GrblProbeResultEvent,
  GrblModalStateEvent,
  GrblOffsetEvent,
  GrblSettingEvent,
  GrblWelcomeEvent,
  GrblStatusReportRawEvent,
  GrblUnknownEvent,
} from './grbl/lineCodec.js';

/** Placeholder readiness flag so the package exposes a real, importable symbol. */
export const SENDER_CORE_READY = false;

/** Returns the canonical package name. Trivial symbol to keep the scaffold green. */
export function senderCorePackageName(): string {
  return '@shapeoko/sender-core';
}
