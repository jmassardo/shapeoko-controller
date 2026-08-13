/**
 * @shapeoko/sender-core — g-code sender core for the Shapeoko controller.
 *
 * This package is intentionally a scaffold only. The real GRBL serial transport
 * (via the `serialport` library), streaming/flow control, and machine state
 * machine are added in later issues. This is explicitly NOT CNCjs. No serial,
 * WebSocket, or GRBL behavior lives here yet.
 */

/** Placeholder readiness flag so the package exposes a real, importable symbol. */
export const SENDER_CORE_READY = false;

/** Returns the canonical package name. Trivial symbol to keep the scaffold green. */
export function senderCorePackageName(): string {
  return '@shapeoko/sender-core';
}
