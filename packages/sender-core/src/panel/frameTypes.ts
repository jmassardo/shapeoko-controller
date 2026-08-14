/**
 * Panel serial wire-format constants, message types, and payload codecs (Pi
 * side, issue #55).
 *
 * NORMATIVE SOURCE — DO NOT EDIT THE WIRE FORMAT HERE. The single source of
 * truth for every constant, offset, width, and enumerator below is the ESP32
 * firmware header `firmware/panel/include/frame_types.h` (issue #54). This file
 * is a byte-for-byte TypeScript MIRROR of that header; it may only change in
 * lock-step with a matching #54 change, because a divergence is a silent
 * cross-language ABI break on the transport that carries the deadman switch and
 * E-stop signalling. The drift guard in `frameTypes.test.ts` reads the C header
 * at runtime and fails loudly if the two ever disagree.
 *
 * A second, independent public mirror of the STABLE constants and types lives in
 * `packages/protocol/src/panel.ts` so packages outside sender-core can consume
 * panel types without importing sender-core internals. That duplication is
 * deliberate (this monorepo has no cross-package imports this wave) and is also
 * covered by the same drift guard.
 *
 * SCOPE NARROWING (payload internals) — READ THIS. `frame_types.h` states that
 * STATUS and EVENT payload INTERNALS are owned by issues #56–#65 ("Pack/unpack
 * helpers are the job of #56-#65, not this codec"). This file therefore
 * implements payload helpers ONLY for the byte layouts the header normatively
 * fixes: HELLO (empty), INFO, EVENT (id + flags), CMD (led + dust), ACK. STATUS
 * is treated as OPAQUE bytes (≤64) with no field helpers. We deliberately do NOT
 * invent event-id values, STATUS fields, LED-pattern values, dust-mode values,
 * or capability bit assignments — none are in the normative header, and #57 is
 * concurrently defining its own event ids outside the shared header. Seam:
 * payload-field semantics belong to #56–#65.
 *
 * PURE data + helpers only: no I/O, no heap-growing buffers, no throwing on
 * malformed input. Every payload decoder is a TOTAL function that reports short
 * input via a discriminated result, never an exception ("reject and count, never
 * guess").
 */

// -----------------------------------------------------------------------------
// Wire constants (mirror of frame_types.h — see the drift guard).
// -----------------------------------------------------------------------------

/** First SYNC anchor byte (`kSync0` in #54). */
export const PANEL_SYNC0 = 0xaa;

/** Second SYNC anchor byte (`kSync1` in #54). Distinct from SYNC0 so a run of
 *  0xAA bytes can never self-satisfy the two-byte anchor. */
export const PANEL_SYNC1 = 0x55;

/** Maximum payload length in bytes (`kMaxPayloadLen` in #54). Any LEN above this
 *  is a bad-length error and must be rejected BEFORE any payload is buffered. */
export const PANEL_MAX_PAYLOAD_LEN = 64;

/** Fixed framing overhead: SYNC0, SYNC1, LEN, TYPE, SEQ, CRC_HI, CRC_LO
 *  (`kFrameOverhead` in #54). A complete frame is this plus LEN bytes. */
export const PANEL_FRAME_OVERHEAD = 7;

/** Smallest complete frame (LEN = 0): `kMinFrameLen` in #54. */
export const PANEL_MIN_FRAME_LEN = PANEL_FRAME_OVERHEAD; // 7

/** Largest complete frame (LEN = 64): `kMaxFrameLen` in #54. */
export const PANEL_MAX_FRAME_LEN = PANEL_FRAME_OVERHEAD + PANEL_MAX_PAYLOAD_LEN; // 71

// -----------------------------------------------------------------------------
// Message types (mirror of `enum class MessageType : uint8_t` in #54).
// -----------------------------------------------------------------------------
//
// Modelled as a `const` object plus a derived union type rather than a TS `enum`
// because the repo compiles with `isolatedModules` and `verbatimModuleSyntax`,
// under which `const enum` is unsafe and a plain `enum` emits runtime code with
// awkward import semantics. This shape is erasable and tree-shakeable.

/** The normative TYPE field values, byte-for-byte from #54. */
export const PanelMessageType = {
  /** panel -> Pi : link handshake, empty payload. */
  Hello: 0x00,
  /** panel -> Pi : firmware version, boot count, capabilities. */
  Info: 0x01,
  /** panel -> Pi : periodic control state; codec treats payload as opaque. */
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

/** Every known message-type byte, for exhaustive iteration in tests/consumers. */
export const PANEL_MESSAGE_TYPE_VALUES: readonly PanelMessageType[] = Object.freeze([
  PanelMessageType.Hello,
  PanelMessageType.Info,
  PanelMessageType.Status,
  PanelMessageType.Event,
  PanelMessageType.Cmd,
  PanelMessageType.Ack,
]);

/**
 * Type guard: is `b` a known message-type byte? An UNKNOWN type byte is NOT
 * rejected by the frame decoder (the decoder surfaces whatever TYPE the wire
 * carried, mirroring the firmware's "observe, never guess" posture); this guard
 * lets a consumer decide how to treat an unknown type without the codec ever
 * dropping an otherwise-intact frame.
 */
export function isPanelMessageType(b: number): b is PanelMessageType {
  return (
    b === PanelMessageType.Hello ||
    b === PanelMessageType.Info ||
    b === PanelMessageType.Status ||
    b === PanelMessageType.Event ||
    b === PanelMessageType.Cmd ||
    b === PanelMessageType.Ack
  );
}

// -----------------------------------------------------------------------------
// Payload decode result — a total, throw-free discriminated union.
// -----------------------------------------------------------------------------

/**
 * The result of decoding a fixed-layout payload. Decoders NEVER throw: short or
 * malformed input yields `{ ok: false, reason }` so the caller can count and
 * discard it ("reject and count, never guess"), exactly as the frame decoder
 * treats a bad CRC.
 */
export type PayloadDecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

// -----------------------------------------------------------------------------
// INFO payload — fw_major u8, fw_minor u8, fw_patch u8, boot_count u32 LE,
// capabilities u32 LE. Total 11 bytes. (Normative in #54.)
// -----------------------------------------------------------------------------

/** Byte length of an INFO payload. */
export const PANEL_INFO_PAYLOAD_LEN = 11;

/** Decoded INFO payload. `capabilities` is an OPAQUE u32 — individual capability
 *  bit meanings are owned by #56–#65 and are deliberately not decoded here. */
export interface PanelInfoPayload {
  fwMajor: number; // u8
  fwMinor: number; // u8
  fwPatch: number; // u8
  bootCount: number; // u32, little-endian on the wire
  capabilities: number; // u32, little-endian on the wire; opaque bitfield
}

/** Encode an INFO payload to its 11-byte little-endian wire form. */
export function encodePanelInfoPayload(p: PanelInfoPayload): Uint8Array {
  const bytes = new Uint8Array(PANEL_INFO_PAYLOAD_LEN);
  const view = new DataView(bytes.buffer);
  // setUint8/Uint32 coerce mod 2^width; documented inputs are already in range.
  view.setUint8(0, p.fwMajor);
  view.setUint8(1, p.fwMinor);
  view.setUint8(2, p.fwPatch);
  view.setUint32(3, p.bootCount, /* littleEndian */ true);
  view.setUint32(7, p.capabilities, /* littleEndian */ true);
  return bytes;
}

/** Decode an INFO payload. Total function: too-short input is rejected. */
export function decodePanelInfoPayload(bytes: Uint8Array): PayloadDecodeResult<PanelInfoPayload> {
  if (bytes.length < PANEL_INFO_PAYLOAD_LEN) {
    return {
      ok: false,
      reason: `INFO payload needs ${String(PANEL_INFO_PAYLOAD_LEN)} bytes, got ${String(bytes.length)}`,
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ok: true,
    value: {
      fwMajor: view.getUint8(0),
      fwMinor: view.getUint8(1),
      fwPatch: view.getUint8(2),
      bootCount: view.getUint32(3, /* littleEndian */ true),
      capabilities: view.getUint32(7, /* littleEndian */ true),
    },
  };
}

// -----------------------------------------------------------------------------
// EVENT payload — event_id u8, flags u8 (+ reserved). We encode the two
// normative fields only; `event_id` and `flags` bit meanings belong to #56–#65
// (and #57's out-of-header event ids), so they are NOT enumerated here.
// -----------------------------------------------------------------------------

/** Byte length of the normative EVENT payload prefix (id + flags). */
export const PANEL_EVENT_PAYLOAD_LEN = 2;

/** Decoded EVENT payload. `eventId`/`flags` values are opaque here by design. */
export interface PanelEventPayload {
  eventId: number; // u8
  flags: number; // u8
}

/** Encode an EVENT payload (2 bytes: id, flags). */
export function encodePanelEventPayload(p: PanelEventPayload): Uint8Array {
  return Uint8Array.of(p.eventId & 0xff, p.flags & 0xff);
}

/** Decode an EVENT payload. Reads the two normative bytes; ignores any trailing
 *  reserved bytes (their layout is owned by #56–#65). Total function. */
export function decodePanelEventPayload(bytes: Uint8Array): PayloadDecodeResult<PanelEventPayload> {
  if (bytes.length < PANEL_EVENT_PAYLOAD_LEN) {
    return {
      ok: false,
      reason: `EVENT payload needs ${String(PANEL_EVENT_PAYLOAD_LEN)} bytes, got ${String(bytes.length)}`,
    };
  }
  // Non-null-asserted via length guard above; noUncheckedIndexedAccess-safe.
  const eventId = bytes[0] as number;
  const flags = bytes[1] as number;
  return { ok: true, value: { eventId, flags } };
}

// -----------------------------------------------------------------------------
// CMD payload — led_pattern u8, dust_mode u8 (+ reserved). Values opaque here.
// -----------------------------------------------------------------------------

/** Byte length of the normative CMD payload prefix (led + dust). */
export const PANEL_CMD_PAYLOAD_LEN = 2;

/** Decoded CMD payload. `ledPattern`/`dustMode` value meanings are owned by
 *  #56–#65 and are not enumerated here. */
export interface PanelCmdPayload {
  ledPattern: number; // u8
  dustMode: number; // u8
}

/** Encode a CMD payload (2 bytes: led_pattern, dust_mode). */
export function encodePanelCmdPayload(p: PanelCmdPayload): Uint8Array {
  return Uint8Array.of(p.ledPattern & 0xff, p.dustMode & 0xff);
}

/** Decode a CMD payload. Ignores trailing reserved bytes. Total function. */
export function decodePanelCmdPayload(bytes: Uint8Array): PayloadDecodeResult<PanelCmdPayload> {
  if (bytes.length < PANEL_CMD_PAYLOAD_LEN) {
    return {
      ok: false,
      reason: `CMD payload needs ${String(PANEL_CMD_PAYLOAD_LEN)} bytes, got ${String(bytes.length)}`,
    };
  }
  const ledPattern = bytes[0] as number;
  const dustMode = bytes[1] as number;
  return { ok: true, value: { ledPattern, dustMode } };
}

// -----------------------------------------------------------------------------
// ACK payload — acked_seq u8, acked_type u8. (Normative in #54.)
// -----------------------------------------------------------------------------

/** Byte length of an ACK payload. */
export const PANEL_ACK_PAYLOAD_LEN = 2;

/** Decoded ACK payload. */
export interface PanelAckPayload {
  ackedSeq: number; // u8
  ackedType: number; // u8
}

/** Encode an ACK payload (2 bytes: acked_seq, acked_type). */
export function encodePanelAckPayload(p: PanelAckPayload): Uint8Array {
  return Uint8Array.of(p.ackedSeq & 0xff, p.ackedType & 0xff);
}

/** Decode an ACK payload. Total function. */
export function decodePanelAckPayload(bytes: Uint8Array): PayloadDecodeResult<PanelAckPayload> {
  if (bytes.length < PANEL_ACK_PAYLOAD_LEN) {
    return {
      ok: false,
      reason: `ACK payload needs ${String(PANEL_ACK_PAYLOAD_LEN)} bytes, got ${String(bytes.length)}`,
    };
  }
  const ackedSeq = bytes[0] as number;
  const ackedType = bytes[1] as number;
  return { ok: true, value: { ackedSeq, ackedType } };
}

// -----------------------------------------------------------------------------
// HELLO payload — empty (LEN = 0). Provided for symmetry; there is nothing to
// decode. STATUS has no field helpers on purpose (opaque bytes, owned by
// #56–#65).
// -----------------------------------------------------------------------------

/** Encode a HELLO payload: always empty. */
export function encodePanelHelloPayload(): Uint8Array {
  return new Uint8Array(0);
}
