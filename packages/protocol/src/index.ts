/**
 * @shapeoko/protocol — shared protocol contract for the Shapeoko controller.
 *
 * This package is intentionally a scaffold only. The real shared protocol types
 * (status reports, real-time commands, WebSocket message contracts) are added in
 * issue #13. No machine runtime behavior lives here yet.
 */

/** Placeholder version marker so the package exposes a real, importable symbol. */
export const PROTOCOL_CONTRACT_VERSION = '0.0.0';

/** Returns the canonical package name. Trivial symbol to keep the scaffold green. */
export function protocolPackageName(): string {
  return '@shapeoko/protocol';
}
