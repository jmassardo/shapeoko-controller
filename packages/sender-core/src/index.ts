/**
 * @shapeoko/sender-core — g-code sender core for the Shapeoko controller.
 *
 * This package now owns the typed serial transport layer: a strongly-typed
 * contract ({@link SerialTransport}) with a real `serialport`-backed
 * implementation ({@link SerialPortTransport}) and a deterministic in-memory
 * double ({@link FakeTransport}) for tests. Higher-level concerns — port
 * discovery, GRBL line parsing, real-time prioritization, and G-code streaming
 * flow control — are layered on top of this transport in later issues. This is
 * explicitly NOT CNCjs.
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

/** Placeholder readiness flag so the package exposes a real, importable symbol. */
export const SENDER_CORE_READY = false;

/** Returns the canonical package name. Trivial symbol to keep the scaffold green. */
export function senderCorePackageName(): string {
  return '@shapeoko/sender-core';
}
