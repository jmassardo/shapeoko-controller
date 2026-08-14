// SPDX-License-Identifier: MIT
//
// frame.h — framed serial protocol codec (encoder + decoder + CRC-16) for the
// ESP32 panel firmware (issue #54).
//
// This is PURE HOST LOGIC. It has NO hardware dependency: no Arduino/ESP-IDF
// headers, no HAL, no timers, no I/O. It transforms opaque payload bytes to and
// from the normative wire format defined in frame_types.h and nothing else. That
// keeps it fully unit-testable on the CI host under the `native` PlatformIO
// environment (CI has no ESP32).
//
// SAFETY POSTURE (this transport carries the deadman switch and E-stop signals):
//   * Corrupted input can NEVER cause a payload to be acted upon. Every failure
//     mode is "reject and count", never "guess".
//   * No exceptions, no assert (an assert could abort a shipping build), no heap
//     (no new/malloc/std::vector/std::string). Every codec function is noexcept.
//   * The decoder owns a fixed, statically sized buffer; work is O(1) per byte;
//     malformed input can never hang, over-read, or overflow.
//
// This header keeps ALL symbols inside namespace panel::serial with NO
// file-scope `using namespace`, because frame.cpp is #included directly into the
// host test translation unit (see test/test_frame/test_frame.cpp and the
// platformio.ini test_build_src coupling documented there). Anything at global
// scope here would leak into that TU.

#ifndef PANEL_FRAME_H
#define PANEL_FRAME_H

#include <cstddef>
#include <cstdint>

#include "frame_types.h"

namespace panel {
namespace serial {

// -----------------------------------------------------------------------------
// CRC-16/CCITT-FALSE (NORMATIVE)
// -----------------------------------------------------------------------------
// Poly 0x1021, Init 0xFFFF, RefIn false, RefOut false, XorOut 0x0000.
// Known answer: crc16_ccitt_false("123456789") == 0x29B1.
// Bitwise (not table-driven): a 256-entry uint16 table would cost 512 B of flash
// for throughput we do not need at ~7 kB/s. Returns the CRC of `len` bytes at
// `data`; a null/zero-length range yields the init value 0xFFFF.
std::uint16_t crc16_ccitt_false(const std::uint8_t* data, std::size_t len) noexcept;

// -----------------------------------------------------------------------------
// Decoder counters — observable, monotonically increasing diagnostics.
// -----------------------------------------------------------------------------
struct DecoderCounters {
  std::uint32_t frames_ok     = 0;  // CRC-valid frames emitted
  std::uint32_t bad_crc       = 0;  // CRC mismatch, frame discarded
  std::uint32_t bad_length    = 0;  // LEN > kMaxPayloadLen, frame rejected
  std::uint32_t garbage_bytes = 0;  // bytes discarded while hunting for SYNC
  std::uint32_t resyncs       = 0;  // re-entries to SYNC search after a
                                    // partial/failed frame (bad length or CRC)
};

// -----------------------------------------------------------------------------
// A decoded frame. `payload` points into decoder-owned storage and is valid only
// until the next byte is pushed into the same decoder. Copy the bytes out if you
// need them longer.
// -----------------------------------------------------------------------------
struct DecodedFrame {
  MessageType type = MessageType::kHello;
  std::uint8_t seq = 0;
  const std::uint8_t* payload = nullptr;  // into decoder buffer; valid until next push
  std::uint8_t len = 0;
};

// -----------------------------------------------------------------------------
// FrameDecoder — a byte-at-a-time streaming state machine.
// -----------------------------------------------------------------------------
// Feed bytes as they arrive (from any source, in any chunking). O(1) work per
// byte, fixed memory, never throws, never hangs. When a complete CRC-valid frame
// is assembled, push_byte returns true and fills `out`.
//
// DECODER SEQUENCE POLICY — OBSERVE AND COUNT, NEVER REJECT (safety crux):
// a frame that passes CRC is, by definition, intact. Dropping an intact frame
// merely because its sequence number was duplicate, out-of-order, or skipped
// could discard a valid E-stop or deadman EVENT. So the decoder surfaces SEQ and
// leaves de-duplication / gap-driven recovery to #56-#65, which have the full
// application context to do it safely.
class FrameDecoder {
 public:
  FrameDecoder() noexcept;

  // Push one byte. Returns true and fills `out` iff this byte completed a
  // CRC-valid frame. `out.payload` then points into this decoder's buffer and is
  // valid until the next push_byte/push_bytes/reset call.
  bool push_byte(std::uint8_t b, DecodedFrame& out) noexcept;

  // Push a buffer of bytes, delivering each completed frame to `sink(const
  // DecodedFrame&)`. Implemented PURELY in terms of push_byte, so "split one byte
  // at a time" and "delivered in one buffer" are literally the same code path.
  // The DecodedFrame handed to the sink is valid only for the duration of that
  // sink call (its payload points into the decoder buffer).
  template <typename Sink>
  void push_bytes(const std::uint8_t* data, std::size_t len, Sink&& sink) noexcept {
    if (data == nullptr) {
      return;
    }
    for (std::size_t i = 0; i < len; ++i) {
      DecodedFrame out;
      if (push_byte(data[i], out)) {
        sink(out);
      }
    }
  }

  const DecoderCounters& counters() const noexcept { return counters_; }

  // Return to SYNC search and clear the working buffer. Counters are left
  // untouched (diagnostics persist across a resynchronise).
  void reset() noexcept;

 private:
  // Wire-order state machine. O(1) per byte.
  enum class State : std::uint8_t {
    kSync0,   // hunting for 0xAA
    kSync1,   // saw 0xAA, expect 0x55
    kLen,     // expect LEN
    kType,    // expect TYPE
    kSeq,     // expect SEQ
    kPayload, // gathering exactly LEN payload bytes
    kCrcHi,   // expect CRC high byte
    kCrcLo,   // expect CRC low byte
  };

  DecoderCounters counters_;         // diagnostics; survive reset()
  State state_ = State::kSync0;
  std::uint8_t len_ = 0;             // declared payload length for this frame
  std::uint8_t payload_pos_ = 0;     // payload bytes gathered so far
  MessageType type_ = MessageType::kHello;
  std::uint8_t seq_ = 0;
  std::uint16_t crc_calc_ = 0;       // CRC accumulated over LEN,TYPE,SEQ,PAYLOAD
  std::uint16_t crc_recv_ = 0;       // CRC received from the wire (big-endian)
  std::uint8_t payload_[kMaxPayloadLen] = {};  // fixed, no heap ever

  // Fold one header/payload byte into the running CRC (same algorithm as the
  // one-shot crc16_ccitt_false; the two are asserted equivalent in the tests).
  void crc_update(std::uint8_t b) noexcept;
};

// -----------------------------------------------------------------------------
// FrameEncoder — turns (type, payload) into one framed byte sequence.
// -----------------------------------------------------------------------------
// encode() is a pure function of its arguments emitting exactly ONE frame of
// exactly the type passed. The codec has no message queue, no outbound buffer,
// and no type-rewriting path, so EVENT frames can never be coalesced with or
// downgraded into STATUS frames — that guarantee is structural, not merely
// avoided (satisfies the "priority EVENT never coalesced" acceptance criterion).
class FrameEncoder {
 public:
  FrameEncoder() noexcept;

  // Encode one frame into `out` (capacity `out_cap`). Stamps the current
  // sequence number, then auto-increments it (wrap 255->0) ONLY on success.
  // Returns the number of bytes written, or 0 (writing nothing) if:
  //   * payload_len > kMaxPayloadLen, or
  //   * out_cap < kFrameOverhead + payload_len (not enough room for a full frame).
  // Never throws, never over-writes past out_cap.
  std::size_t encode(MessageType type, const std::uint8_t* payload,
                     std::uint8_t payload_len, std::uint8_t* out,
                     std::size_t out_cap) noexcept;

  // The sequence number that the NEXT successful encode() will stamp.
  std::uint8_t peek_next_seq() const noexcept { return next_seq_; }

 private:
  std::uint8_t next_seq_ = 0;
};

}  // namespace serial
}  // namespace panel

#endif  // PANEL_FRAME_H
