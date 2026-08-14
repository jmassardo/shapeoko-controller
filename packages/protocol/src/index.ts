/**
 * @shapeoko/protocol — shared protocol contract for the Shapeoko controller.
 *
 * The single source of truth for the types exchanged between the protocol,
 * sender-core, and UI workspaces: GRBL machine state and status reports
 * (`machine.ts`), the work coordinate systems plus the `$G` parser state and
 * `$#` offsets responses (`coordinates.ts`), the tolerant GRBL settings map and
 * accessors (`settings.ts`), the ESP32 operator-panel contract (`panel.ts`),
 * and the WebSocket command/event unions (`api.ts`).
 *
 * This package is intentionally PURE: no I/O, no `serialport`, no React, no
 * filesystem access, and no runtime dependencies. It models what the Carbide 3D
 * GRBL 1.1 fork reports and what our sender/pendant exchange — it does not talk
 * to hardware. Parsing live serial reports — `?` status, and equally the `$G`
 * and `$#` responses — belongs to sender-core (issues #24 and #26).
 *
 * Several protocol facts remain UNVERIFIED against the closed-source Carbide
 * fork (issues #16–#20). The ones that touch this type surface — the welcome
 * string and the exact `$G` parser-state field set (#16), the OEM `$`-settings
 * above `$132` (#17), and the probe-pin polarity default (#20) — are each
 * isolated behind a clearly marked seam. Search this package
 * for `UNVERIFIED (#` to find every one. The ESP32 panel wire encoding, formerly
 * a seam here, is now closed: its byte envelope is normative in
 * `firmware/panel/include/frame_types.h` (#54) and mirrored for consumers by the
 * `PANEL_WIRE_*` constants in `panel.ts` (#55). The remaining fork uncertainties (M6
 * tool-change behaviour, BitZero V1 dimensions) are behavioural and belong to
 * sender-core, not this contract.
 */

/** Semantic version of the protocol contract this package publishes. */
export const PROTOCOL_CONTRACT_VERSION = '0.1.0';

export * from './machine.js';
export * from './coordinates.js';
export * from './settings.js';
export * from './panel.js';
export * from './api.js';
