// SPDX-License-Identifier: MIT
//
// frame.cpp — implementation of the framed serial protocol codec (issue #54).
//
// This translation unit is compiled TWO ways:
//   1. On the real target (esp32dev), it is compiled normally as a src/ file,
//      so the encoder/decoder become real firmware.
//   2. On the host (native env), it is #included directly into the test TU
//      (test/test_frame/test_frame.cpp). That is legal ONLY because the native
//      environment sets test_build_src = no, so src/frame.cpp is NOT separately
//      compiled/linked into the test — there is therefore no duplicate-symbol
//      collision. See the include-site comment in the test for the full coupling.
//
// Because of (2), this file must be safe to pull into another TU: it keeps every
// symbol inside namespace panel::serial, uses NO file-scope `using namespace`,
// and gives its internal helpers internal linkage. It uses no exceptions, no
// assert, and no heap.

#include "frame.h"

#include "frame_types.h"

namespace panel {
namespace serial {

namespace {

// One CRC-16/CCITT-FALSE step folding a single byte into a running register.
// Kept here so the streaming decoder and the one-shot function share EXACTLY one
// definition of the algorithm (the tests assert the two agree).
inline std::uint16_t crc16_step(std::uint16_t crc, std::uint8_t b) noexcept {
  crc = static_cast<std::uint16_t>(crc ^ (static_cast<std::uint16_t>(b) << 8));
  for (int i = 0; i < 8; ++i) {
    if (crc & 0x8000) {
      crc = static_cast<std::uint16_t>(static_cast<std::uint16_t>(crc << 1) ^ 0x1021);
    } else {
      crc = static_cast<std::uint16_t>(crc << 1);
    }
  }
  return crc;
}

}  // namespace

std::uint16_t crc16_ccitt_false(const std::uint8_t* data, std::size_t len) noexcept {
  std::uint16_t crc = 0xFFFF;
  if (data == nullptr) {
    return crc;
  }
  for (std::size_t i = 0; i < len; ++i) {
    crc = crc16_step(crc, data[i]);
  }
  return crc;
}

// ---------------------------------------------------------------------------
// FrameDecoder
// ---------------------------------------------------------------------------

FrameDecoder::FrameDecoder() noexcept = default;

void FrameDecoder::reset() noexcept {
  // Back to SYNC search, working buffer logically cleared. Counters untouched.
  state_ = State::kSync0;
  len_ = 0;
  payload_pos_ = 0;
  crc_calc_ = 0;
  crc_recv_ = 0;
}

void FrameDecoder::crc_update(std::uint8_t b) noexcept {
  crc_calc_ = crc16_step(crc_calc_, b);
}

bool FrameDecoder::push_byte(std::uint8_t b, DecodedFrame& out) noexcept {
  switch (state_) {
    case State::kSync0:
      // Hunt for SYNC0. Any non-0xAA byte is garbage. The 0xAA itself is NOT yet
      // counted as garbage — it may be a real SYNC0.
      if (b == kSync0) {
        state_ = State::kSync1;
      } else {
        ++counters_.garbage_bytes;
      }
      return false;

    case State::kSync1:
      if (b == kSync1) {
        // Valid 0xAA 0x55 anchor: the pending 0xAA was a real SYNC0.
        state_ = State::kLen;
      } else if (b == kSync0) {
        // 0xAA 0xAA...: the pending 0xAA was garbage, but this new 0xAA could be
        // the real SYNC0, so stay here and count only the discarded one.
        ++counters_.garbage_bytes;
      } else {
        // Pending 0xAA and this byte are both garbage; resume the SYNC0 hunt.
        // Both bytes are discarded, hence += 2 (see
        // test_garbage_before_sync_counted_then_decoded: a lone 0xAA followed by
        // a non-sync byte contributes 2 to garbage_bytes).
        counters_.garbage_bytes += 2;
        state_ = State::kSync0;
      }
      return false;

    case State::kLen:
      // Reject an oversized length BEFORE buffering any payload, so an oversized
      // LEN can never cause an over-read or overflow.
      if (b > kMaxPayloadLen) {
        ++counters_.bad_length;
        ++counters_.resyncs;
        state_ = State::kSync0;
        return false;
      }
      len_ = b;
      payload_pos_ = 0;
      // CRC covers LEN, TYPE, SEQ, PAYLOAD (never SYNC or the CRC field).
      crc_calc_ = 0xFFFF;
      crc_update(len_);
      state_ = State::kType;
      return false;

    case State::kType:
      type_ = static_cast<MessageType>(b);
      crc_update(b);
      state_ = State::kSeq;
      return false;

    case State::kSeq:
      seq_ = b;
      crc_update(b);
      // LEN==0 frames carry no payload: jump straight to the CRC.
      state_ = (len_ == 0) ? State::kCrcHi : State::kPayload;
      return false;

    case State::kPayload:
      payload_[payload_pos_] = b;
      ++payload_pos_;
      crc_update(b);
      if (payload_pos_ >= len_) {
        state_ = State::kCrcHi;
      }
      return false;

    case State::kCrcHi:
      crc_recv_ = static_cast<std::uint16_t>(static_cast<std::uint16_t>(b) << 8);
      state_ = State::kCrcLo;
      return false;

    case State::kCrcLo:
      crc_recv_ = static_cast<std::uint16_t>(crc_recv_ | b);
      state_ = State::kSync0;
      if (crc_recv_ == crc_calc_) {
        // Intact frame. Surface type, seq, and payload. Sequence is OBSERVED,
        // never used to drop/reorder/reject (see policy in frame.h).
        out.type = type_;
        out.seq = seq_;
        out.payload = payload_;
        out.len = len_;
        ++counters_.frames_ok;
        return true;
      }
      // CRC mismatch: discard, count, resynchronise. Never act on the payload.
      ++counters_.bad_crc;
      ++counters_.resyncs;
      return false;
  }
  // Unreachable: every State is handled above. Fail safe to SYNC search.
  state_ = State::kSync0;
  return false;
}

// ---------------------------------------------------------------------------
// FrameEncoder
// ---------------------------------------------------------------------------

FrameEncoder::FrameEncoder() noexcept = default;

std::size_t FrameEncoder::encode(MessageType type, const std::uint8_t* payload,
                                 std::uint8_t payload_len, std::uint8_t* out,
                                 std::size_t out_cap) noexcept {
  if (payload_len > kMaxPayloadLen) {
    return 0;
  }
  if (out == nullptr) {
    return 0;
  }
  if (payload_len > 0 && payload == nullptr) {
    return 0;
  }
  const std::size_t total = kFrameOverhead + static_cast<std::size_t>(payload_len);
  if (out_cap < total) {
    // Not enough room for a full frame — write nothing, report failure.
    return 0;
  }

  out[0] = kSync0;
  out[1] = kSync1;
  out[2] = payload_len;
  out[3] = static_cast<std::uint8_t>(type);
  out[4] = next_seq_;
  for (std::uint8_t i = 0; i < payload_len; ++i) {
    out[5 + i] = payload[i];
  }
  // CRC over the contiguous LEN,TYPE,SEQ,PAYLOAD region (out[2 .. 4+payload_len]).
  const std::uint16_t crc =
      crc16_ccitt_false(&out[2], static_cast<std::size_t>(3) + payload_len);
  out[5 + payload_len] = static_cast<std::uint8_t>(crc >> 8);    // CRC_HI
  out[6 + payload_len] = static_cast<std::uint8_t>(crc & 0xFF);  // CRC_LO

  // Auto-increment only on success; uint8 wraps 255 -> 0 by definition.
  ++next_seq_;
  return total;
}

}  // namespace serial
}  // namespace panel
