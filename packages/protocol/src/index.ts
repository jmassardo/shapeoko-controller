/**
 * @shapeoko/protocol — shared protocol contract for the Shapeoko controller.
 *
 * The single source of truth for the types exchanged between the protocol,
 * sender-core, and UI workspaces: GRBL machine state and status reports
 * (`machine.ts`), the tolerant GRBL settings map and accessors (`settings.ts`),
 * the ESP32 operator-panel contract (`panel.ts`), and the WebSocket
 * command/event unions (`api.ts`).
 *
 * This package is intentionally PURE: no I/O, no `serialport`, no React, no
 * filesystem access, and no runtime dependencies. It models what the Carbide 3D
 * GRBL 1.1 fork reports and what our sender/pendant exchange — it does not talk
 * to hardware. Parsing live serial reports belongs to sender-core (issue #26).
 *
 * Several protocol facts remain UNVERIFIED against the closed-source Carbide
 * fork (issues #16–#20). The ones that touch this type surface — the welcome
 * string (#16), the OEM `$`-settings above `$132` (#17), and the probe-pin
 * polarity default (#20) — are each isolated behind a clearly marked seam, as
 * is the ESP32 panel wire encoding (a later firmware issue). Search this package
 * for `UNVERIFIED (#` to find every one. The remaining fork uncertainties (M6
 * tool-change behaviour, BitZero V1 dimensions) are behavioural and belong to
 * sender-core, not this contract.
 */

/** Semantic version of the protocol contract this package publishes. */
export const PROTOCOL_CONTRACT_VERSION = '0.1.0';

export * from './machine.js';
export * from './settings.js';
export * from './panel.js';
export * from './api.js';
