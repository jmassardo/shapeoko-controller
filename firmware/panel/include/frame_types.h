// SPDX-License-Identifier: MIT
//
// frame_types.h — the SINGLE NORMATIVE wire-format definition for the framed
// panel<->Pi serial protocol (issue #54).
//
// -----------------------------------------------------------------------------
// SHARED CONTRACT — NEITHER SIDE MAY CHANGE THIS UNILATERALLY
// -----------------------------------------------------------------------------
// This header is the one normative statement of the on-the-wire byte layout. It
// is shared, byte-for-byte, with the Pi-side TypeScript mirror (issue #55). The
// ESP32 panel firmware (this side) and the Raspberry Pi host (the other side)
// MUST agree on every constant, offset, width, and enum value below. A change
// here is a change to a cross-language ABI: it may only be made by updating BOTH
// implementations together, never by one side alone. If you are tempted to
// "just tweak" a constant to make one side compile, STOP — you are breaking the
// other side silently.
//
// This transport is what the deadman switch and E-stop signalling ride on, so
// the failure mode of any ambiguity must be "reject and count", never "guess".
//
// -----------------------------------------------------------------------------
// FRAME WIRE FORMAT (NORMATIVE)
// -----------------------------------------------------------------------------
//   Offset  Field     Width  Notes
//     0     SYNC0       1     0xAA  (constant)
//     1     SYNC1       1     0x55  (constant)
//     2     LEN         1     payload length in bytes, 0..kMaxPayloadLen (=64)
//     3     TYPE        1     MessageType enum (uint8)
//     4     SEQ         1     sequence number, uint8, wraps 255->0
//     5     PAYLOAD   LEN     exactly LEN opaque bytes (may be 0)
//   5+LEN   CRC_HI      1     CRC-16 high byte  (big-endian on the wire)
//   6+LEN   CRC_LO      1     CRC-16 low  byte
//
// Total frame = 6 + LEN bytes. Minimum 6 (empty payload), maximum 70 (LEN=64).
//
// SYNC is TWO bytes 0xAA 0x55. One byte would give a 1-in-256 false-lock rate on
// random garbage; two DISTINCT bytes with maximum bit-transition density
// (10101010 01010101) form a stable anchor, and because the two bytes differ, a
// run of 0xAA 0xAA 0xAA... can never self-satisfy the pair.
//
// LEN counts the PAYLOAD ONLY — not the SYNC bytes, not the header, not the CRC.
// Any LEN > kMaxPayloadLen (=64) is a bad-length error and MUST be rejected
// BEFORE any payload buffering, so an oversized length can never cause an
// over-read or a buffer overflow.
//
// -----------------------------------------------------------------------------
// CRC-16 (NORMATIVE)
// -----------------------------------------------------------------------------
// Algorithm: CRC-16/CCITT-FALSE.
//   Polynomial 0x1021, Init 0xFFFF, RefIn false, RefOut false, XorOut 0x0000.
//   Known-answer check("123456789") = 0x29B1.
// Wire byte order is big-endian (CRC_HI then CRC_LO).
// Coverage: LEN, TYPE, SEQ, PAYLOAD. It DELIBERATELY EXCLUDES the SYNC bytes and
// the CRC field itself, so the resync scanner (which only hunts for SYNC) stays
// independent of the checksum.
//
// -----------------------------------------------------------------------------
// FRAMING: pure length-prefix, NO byte stuffing
// -----------------------------------------------------------------------------
// A payload byte equal to 0xAA or 0x55 is consumed as ordinary payload — SYNC
// has no special meaning once we are inside a frame. Once SYNC is matched and
// LEN validated, the decoder consumes exactly LEN payload bytes WITHOUT scanning
// for SYNC. Byte stuffing is unnecessary because a mis-framing can only ever
// produce a CRC failure, which is discarded and counted; the codec never *acts*
// on a mis-framed payload, which is the only property that safety requires.
//
// Accepted, documented worst case: a frame truncated mid-payload will consume
// the following frame's SYNC and bytes as its own payload/CRC, fail CRC, and be
// discarded — potentially swallowing at most ONE following frame before it
// resynchronises on the next 0xAA 0x55. This is bounded to one victim per
// truncation and is fail-safe (reject and count, never act).
//
// -----------------------------------------------------------------------------
// SEQUENCE SEMANTICS
// -----------------------------------------------------------------------------
// The encoder auto-increments an 8-bit sequence number, stamping each frame,
// then incrementing (wrap 255->0 is defined and normal). The decoder OBSERVES
// AND COUNTS, NEVER REJECTS: it surfaces SEQ on the decoded frame and does NOT
// drop, reorder, or reject a frame whose sequence is unexpected. See the safety
// rationale in frame.h. Dedup/gap-driven recovery belongs to #56-#65.
//
// -----------------------------------------------------------------------------
// CROSS-LANGUAGE ABI TRAP (payload byte layouts)
// -----------------------------------------------------------------------------
// The #54 codec treats every payload as fully OPAQUE bytes. The tables below are
// the NORMATIVE per-payload byte layouts shared with #55; they are documented
// here so both languages agree without ever relying on C struct padding (which
// is implementation-defined and has no TypeScript equivalent). ALL multi-byte
// payload scalars are LITTLE-ENDIAN (stated once, applies to every payload
// field). Pack/unpack helpers are the job of #56-#65, not this codec.
//
//   Type    Byte layout (multi-byte fields little-endian)
//   ------  --------------------------------------------------------------
//   HELLO   empty (LEN=0)
//   INFO    fw_major u8, fw_minor u8, fw_patch u8, boot_count u32,
//           capabilities u32
//   STATUS  fields TBD by #56-#65; codec treats as opaque bytes <= 64
//   EVENT   event_id u8, flags u8 (+ reserved)
//   CMD     led_pattern u8, dust_mode u8 (+ reserved)
//   ACK     acked_seq u8, acked_type u8
//
// These are deliberately minimal: STATUS/EVENT internals are owned by #56-#65
// and must not be over-specified here.

#ifndef PANEL_FRAME_TYPES_H
#define PANEL_FRAME_TYPES_H

#include <cstddef>
#include <cstdint>

namespace panel {
namespace serial {

// The two SYNC bytes that anchor the start of every frame (see header comment).
inline constexpr std::uint8_t kSync0 = 0xAA;
inline constexpr std::uint8_t kSync1 = 0x55;

// Maximum payload length in bytes. The decoder owns a fixed buffer of exactly
// this size; any LEN greater than this is a bad-length error.
inline constexpr std::uint8_t kMaxPayloadLen = 64;

// Fixed framing overhead (SYNC0, SYNC1, LEN, TYPE, SEQ, CRC_HI, CRC_LO).
// A complete frame is kFrameOverhead + LEN bytes.
inline constexpr std::size_t kFrameOverhead = 7;

// Smallest and largest complete frame sizes (LEN=0 and LEN=kMaxPayloadLen).
inline constexpr std::size_t kMinFrameLen = kFrameOverhead;                     // 7
inline constexpr std::size_t kMaxFrameLen = kFrameOverhead + kMaxPayloadLen;    // 71

// Message types — the normative TYPE field values shared with #55.
enum class MessageType : std::uint8_t {
  kHello  = 0x00,  // panel -> Pi : link handshake, no/empty payload
  kInfo   = 0x01,  // panel -> Pi : firmware version, boot count, capabilities
  kStatus = 0x02,  // panel -> Pi : periodic 100 Hz control state
  kEvent  = 0x03,  // panel -> Pi : PRIORITY safety events (deadman/E-stop) —
                   //               never coalesced or downgraded to STATUS
  kCmd    = 0x04,  // Pi -> panel : LED patterns, dust mode
  kAck    = 0x05,  // either way  : acknowledgement of a received frame
};

}  // namespace serial
}  // namespace panel

#endif  // PANEL_FRAME_TYPES_H
