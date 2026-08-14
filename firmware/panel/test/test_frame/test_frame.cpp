// SPDX-License-Identifier: MIT
//
// test_frame.cpp — host-side Unity tests for the framed serial protocol codec
// (issue #54): CRC-16/CCITT-FALSE, the FrameEncoder, and the streaming
// FrameDecoder.
//
// Runs under the `native` PlatformIO environment on the CI host with NO ESP32
// attached and NO Arduino/ESP32 headers available — the codec is pure logic, so
// every property below is provable off-target. This transport carries the
// deadman switch and E-stop signalling, so the corruption/truncation corpus is a
// first-class deliverable, not an afterthought: corrupted input must NEVER cause
// a payload to be acted upon, must never throw or hang, and every failure mode is
// "reject and count", never "guess".
//
// LINKING NOTE (test_build_src coupling — read before editing platformio.ini):
// The native env sets `test_build_src = no`, so src/frame.cpp is NOT separately
// compiled or linked into this test binary. We therefore pull the implementation
// directly into THIS translation unit with the #include below. Because src/ is
// not separately compiled in this env, that creates NO duplicate-symbol
// collision — that single fact is what makes it legal. If a future reader flips
// `test_build_src` to `yes`, this #include of frame.cpp MUST be removed, or the
// build will fail with duplicate-symbol link errors.

#include "frame.h"              // resolved via the project include/ dir (on CPPPATH)
#include "../../src/frame.cpp"  // pulls the implementation INTO this TU (see note above)

#include <unity.h>

#include <cstddef>
#include <cstdint>
#include <vector>

using panel::serial::crc16_ccitt_false;
using panel::serial::DecodedFrame;
using panel::serial::FrameDecoder;
using panel::serial::FrameEncoder;
using panel::serial::kFrameOverhead;
using panel::serial::kMaxFrameLen;
using panel::serial::kMaxPayloadLen;
using panel::serial::kSync0;
using panel::serial::kSync1;
using panel::serial::MessageType;

namespace {

// A decoded frame copied out of decoder-owned storage so tests can keep it.
struct Captured {
  MessageType type;
  std::uint8_t seq;
  std::vector<std::uint8_t> payload;
};

// Build a well-formed frame's wire bytes (SYNC0, SYNC1, LEN, TYPE, SEQ, PAYLOAD,
// CRC_HI, CRC_LO) using the one-shot CRC. Used as a golden reference independent
// of the encoder so encoder and decoder are cross-checked against a third source.
std::vector<std::uint8_t> build_frame(MessageType type, std::uint8_t seq,
                                      const std::vector<std::uint8_t>& payload) {
  std::vector<std::uint8_t> crc_region;
  crc_region.push_back(static_cast<std::uint8_t>(payload.size()));
  crc_region.push_back(static_cast<std::uint8_t>(type));
  crc_region.push_back(seq);
  for (std::uint8_t b : payload) {
    crc_region.push_back(b);
  }
  const std::uint16_t crc = crc16_ccitt_false(crc_region.data(), crc_region.size());

  std::vector<std::uint8_t> frame;
  frame.push_back(kSync0);
  frame.push_back(kSync1);
  frame.push_back(static_cast<std::uint8_t>(payload.size()));
  frame.push_back(static_cast<std::uint8_t>(type));
  frame.push_back(seq);
  for (std::uint8_t b : payload) {
    frame.push_back(b);
  }
  frame.push_back(static_cast<std::uint8_t>(crc >> 8));
  frame.push_back(static_cast<std::uint8_t>(crc & 0xFF));
  return frame;
}

// Push a byte buffer through a decoder, capturing every emitted frame.
std::vector<Captured> decode_all(FrameDecoder& dec,
                                 const std::vector<std::uint8_t>& bytes) {
  std::vector<Captured> got;
  dec.push_bytes(bytes.data(), bytes.size(), [&](const DecodedFrame& f) {
    Captured c;
    c.type = f.type;
    c.seq = f.seq;
    c.payload.assign(f.payload, f.payload + f.len);
    got.push_back(c);
  });
  return got;
}

// Encode one frame with the given encoder into a caller buffer; return wire bytes.
std::vector<std::uint8_t> encode_one(FrameEncoder& enc, MessageType type,
                                     const std::vector<std::uint8_t>& payload) {
  std::uint8_t buf[kMaxFrameLen];
  const std::size_t n = enc.encode(type, payload.data(),
                                   static_cast<std::uint8_t>(payload.size()), buf,
                                   sizeof(buf));
  return std::vector<std::uint8_t>(buf, buf + n);
}

}  // namespace

// ---------------------------------------------------------------------------
// 1. CRC known-answer vectors (NORMATIVE)
// ---------------------------------------------------------------------------

void test_crc_known_answer_123456789(void) {
  const char* s = "123456789";
  TEST_ASSERT_EQUAL_HEX16(
      0x29B1, crc16_ccitt_false(reinterpret_cast<const std::uint8_t*>(s), 9));
}

void test_crc_worked_frame_vectors(void) {
  const std::uint8_t v1[] = {0x02, 0x03, 0x01, 0xDE, 0xAD};
  TEST_ASSERT_EQUAL_HEX16(0xAB0C, crc16_ccitt_false(v1, sizeof(v1)));
  const std::uint8_t v2[] = {0x00, 0x00, 0x00};
  TEST_ASSERT_EQUAL_HEX16(0xCC9C, crc16_ccitt_false(v2, sizeof(v2)));
}

void test_worked_full_frame_bytes_match(void) {
  // AA 55 02 03 01 DE AD AB 0C
  const std::uint8_t want1[] = {0xAA, 0x55, 0x02, 0x03, 0x01,
                                0xDE, 0xAD, 0xAB, 0x0C};
  std::vector<std::uint8_t> f1 = build_frame(MessageType::kEvent, 0x01, {0xDE, 0xAD});
  TEST_ASSERT_EQUAL_UINT32(sizeof(want1), f1.size());
  TEST_ASSERT_EQUAL_UINT8_ARRAY(want1, f1.data(), sizeof(want1));

  // AA 55 00 00 00 CC 9C
  const std::uint8_t want2[] = {0xAA, 0x55, 0x00, 0x00, 0x00, 0xCC, 0x9C};
  std::vector<std::uint8_t> f2 = build_frame(MessageType::kHello, 0x00, {});
  TEST_ASSERT_EQUAL_UINT32(sizeof(want2), f2.size());
  TEST_ASSERT_EQUAL_UINT8_ARRAY(want2, f2.data(), sizeof(want2));
}

void test_crc_null_and_empty_is_init_value(void) {
  TEST_ASSERT_EQUAL_HEX16(0xFFFF, crc16_ccitt_false(nullptr, 0));
  const std::uint8_t dummy = 0;
  TEST_ASSERT_EQUAL_HEX16(0xFFFF, crc16_ccitt_false(&dummy, 0));
}

// Streaming CRC (inside the decoder) must agree with the one-shot function: a
// frame whose CRC was computed one-shot is accepted; a one-bit change is not.
void test_crc_streaming_matches_oneshot(void) {
  std::vector<std::uint8_t> frame = build_frame(MessageType::kInfo, 7, {1, 2, 3, 4});
  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, frame);
  TEST_ASSERT_EQUAL_UINT32(1, got.size());
  TEST_ASSERT_EQUAL_UINT32(1, dec.counters().frames_ok);

  frame[6] ^= 0x01;  // flip one payload bit; one-shot vs streaming would disagree
  FrameDecoder dec2;
  std::vector<Captured> got2 = decode_all(dec2, frame);
  TEST_ASSERT_EQUAL_UINT32(0, got2.size());
  TEST_ASSERT_EQUAL_UINT32(1, dec2.counters().bad_crc);
}

// ---------------------------------------------------------------------------
// 2. Round-trip for every message type: type, seq, payload byte-for-byte.
// ---------------------------------------------------------------------------

void roundtrip_one(MessageType type, const std::vector<std::uint8_t>& payload) {
  FrameEncoder enc;
  std::vector<std::uint8_t> wire = encode_one(enc, type, payload);
  TEST_ASSERT_EQUAL_UINT32(kFrameOverhead + payload.size(), wire.size());

  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, wire);
  TEST_ASSERT_EQUAL_UINT32(1, got.size());
  TEST_ASSERT_EQUAL_UINT8(static_cast<std::uint8_t>(type),
                          static_cast<std::uint8_t>(got[0].type));
  TEST_ASSERT_EQUAL_UINT8(0, got[0].seq);  // fresh encoder starts at seq 0
  TEST_ASSERT_EQUAL_UINT32(payload.size(), got[0].payload.size());
  if (!payload.empty()) {
    TEST_ASSERT_EQUAL_UINT8_ARRAY(payload.data(), got[0].payload.data(),
                                  payload.size());
  }
  TEST_ASSERT_EQUAL_UINT32(1, dec.counters().frames_ok);
}

void test_roundtrip_hello(void) { roundtrip_one(MessageType::kHello, {}); }
void test_roundtrip_info(void) {
  roundtrip_one(MessageType::kInfo,
                {1, 2, 3, 0x10, 0x20, 0x30, 0x40, 0xAA, 0xBB, 0xCC, 0xDD});
}
void test_roundtrip_status(void) {
  roundtrip_one(MessageType::kStatus, {0x00, 0x7F, 0x80, 0xFF, 0x42});
}
void test_roundtrip_event(void) { roundtrip_one(MessageType::kEvent, {0x01, 0x80}); }
void test_roundtrip_cmd(void) { roundtrip_one(MessageType::kCmd, {0x03, 0x01}); }
void test_roundtrip_ack(void) { roundtrip_one(MessageType::kAck, {0x2A, 0x03}); }

// The enum values are the wire contract; assert them independently of the CRC
// vectors (which happen to use TYPE=0x03) so the two facts are not coupled.
void test_message_type_enum_values(void) {
  TEST_ASSERT_EQUAL_UINT8(0x00, static_cast<std::uint8_t>(MessageType::kHello));
  TEST_ASSERT_EQUAL_UINT8(0x01, static_cast<std::uint8_t>(MessageType::kInfo));
  TEST_ASSERT_EQUAL_UINT8(0x02, static_cast<std::uint8_t>(MessageType::kStatus));
  TEST_ASSERT_EQUAL_UINT8(0x03, static_cast<std::uint8_t>(MessageType::kEvent));
  TEST_ASSERT_EQUAL_UINT8(0x04, static_cast<std::uint8_t>(MessageType::kCmd));
  TEST_ASSERT_EQUAL_UINT8(0x05, static_cast<std::uint8_t>(MessageType::kAck));
}

// ---------------------------------------------------------------------------
// 3. Truncation at EVERY prefix boundary emits nothing and never hangs/over-reads.
// ---------------------------------------------------------------------------

void test_every_truncated_prefix_emits_nothing(void) {
  std::vector<std::uint8_t> frame =
      build_frame(MessageType::kStatus, 9, {0x11, 0x22, 0x33, 0x44, 0x55, 0xAA});
  // Every proper prefix (mid-SYNC, mid-header, mid-payload, mid-CRC).
  for (std::size_t prefix = 1; prefix < frame.size(); ++prefix) {
    FrameDecoder dec;
    std::vector<std::uint8_t> part(frame.begin(), frame.begin() + prefix);
    std::vector<Captured> got = decode_all(dec, part);
    TEST_ASSERT_EQUAL_UINT32(0, got.size());
    TEST_ASSERT_EQUAL_UINT32(0, dec.counters().frames_ok);
  }
  // The full frame still decodes cleanly (sanity anchor for the loop above).
  FrameDecoder dec;
  TEST_ASSERT_EQUAL_UINT32(1, decode_all(dec, frame).size());
}

// ---------------------------------------------------------------------------
// 4. Every single-bit payload corruption is rejected and counted by CRC.
// ---------------------------------------------------------------------------

void test_every_payload_bit_flip_rejected(void) {
  const std::vector<std::uint8_t> payload = {0x10, 0x20, 0x30, 0x40, 0x50};
  std::vector<std::uint8_t> good = build_frame(MessageType::kInfo, 3, payload);
  const std::size_t payload_start = 5;  // after SYNC0,SYNC1,LEN,TYPE,SEQ
  for (std::size_t i = 0; i < payload.size(); ++i) {
    for (int bit = 0; bit < 8; ++bit) {
      std::vector<std::uint8_t> bad = good;
      bad[payload_start + i] ^= static_cast<std::uint8_t>(1u << bit);
      FrameDecoder dec;
      std::vector<Captured> got = decode_all(dec, bad);
      TEST_ASSERT_EQUAL_UINT32(0, got.size());
      TEST_ASSERT_EQUAL_UINT32(1, dec.counters().bad_crc);
      TEST_ASSERT_EQUAL_UINT32(0, dec.counters().frames_ok);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Corruption of the CRC field itself is rejected and counted.
// ---------------------------------------------------------------------------

void test_corrupt_crc_field_rejected(void) {
  std::vector<std::uint8_t> good = build_frame(MessageType::kCmd, 1, {0xDE, 0xAD});
  {
    std::vector<std::uint8_t> bad = good;
    bad[bad.size() - 2] ^= 0xFF;  // flip CRC_HI
    FrameDecoder dec;
    TEST_ASSERT_EQUAL_UINT32(0, decode_all(dec, bad).size());
    TEST_ASSERT_EQUAL_UINT32(1, dec.counters().bad_crc);
  }
  {
    std::vector<std::uint8_t> bad = good;
    bad[bad.size() - 1] ^= 0xFF;  // flip CRC_LO
    FrameDecoder dec;
    TEST_ASSERT_EQUAL_UINT32(0, decode_all(dec, bad).size());
    TEST_ASSERT_EQUAL_UINT32(1, dec.counters().bad_crc);
  }
}

// ---------------------------------------------------------------------------
// 6. Out-of-order / duplicate / skipped sequence numbers are DELIVERED, not
//    rejected — the executable statement of the observe-never-reject safety
//    decision (dropping an intact frame could discard a valid E-stop EVENT).
// ---------------------------------------------------------------------------

void test_sequence_observed_never_rejected(void) {
  const std::uint8_t seqs[] = {5, 5, 200, 3, 0};  // dup, jump back, skip
  std::vector<std::uint8_t> stream;
  for (std::uint8_t s : seqs) {
    std::vector<std::uint8_t> f = build_frame(MessageType::kEvent, s, {s});
    stream.insert(stream.end(), f.begin(), f.end());
  }
  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, stream);
  TEST_ASSERT_EQUAL_UINT32(5, got.size());
  for (std::size_t i = 0; i < got.size(); ++i) {
    TEST_ASSERT_EQUAL_UINT8(seqs[i], got[i].seq);
    TEST_ASSERT_EQUAL_UINT8(seqs[i], got[i].payload[0]);
  }
  TEST_ASSERT_EQUAL_UINT32(5, dec.counters().frames_ok);
}

// ---------------------------------------------------------------------------
// 7. Framing bytes (0xAA, 0x55, and the literal AA 55 pair) inside a payload are
//    ordinary bytes and round-trip byte-for-byte (pure length-prefix framing).
// ---------------------------------------------------------------------------

void test_framing_bytes_in_payload_roundtrip(void) {
  const std::vector<std::uint8_t> payload = {0xAA, 0x55, 0xAA, 0x55, 0x00, 0xAA, 0x55};
  FrameEncoder enc;
  std::vector<std::uint8_t> wire = encode_one(enc, MessageType::kStatus, payload);
  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, wire);
  TEST_ASSERT_EQUAL_UINT32(1, got.size());
  TEST_ASSERT_EQUAL_UINT32(payload.size(), got[0].payload.size());
  TEST_ASSERT_EQUAL_UINT8_ARRAY(payload.data(), got[0].payload.data(), payload.size());
}

// ---------------------------------------------------------------------------
// 8. Zero-length and maximum-length payloads round-trip; 65 bytes is rejected.
// ---------------------------------------------------------------------------

void test_zero_and_max_length_payload_roundtrip(void) {
  roundtrip_one(MessageType::kHello, {});  // LEN = 0

  std::vector<std::uint8_t> maxp;
  for (std::size_t i = 0; i < kMaxPayloadLen; ++i) {
    maxp.push_back(static_cast<std::uint8_t>(i * 7 + 1));
  }
  TEST_ASSERT_EQUAL_UINT32(64, maxp.size());
  roundtrip_one(MessageType::kStatus, maxp);
}

void test_encode_rejects_oversized_payload(void) {
  std::uint8_t payload[65] = {0};
  std::uint8_t out[kMaxFrameLen + 8];
  for (std::size_t i = 0; i < sizeof(out); ++i) {
    out[i] = 0xEE;  // sentinel
  }
  FrameEncoder enc;
  const std::size_t n = enc.encode(MessageType::kStatus, payload, 65, out, sizeof(out));
  TEST_ASSERT_EQUAL_UINT32(0, n);
  TEST_ASSERT_EQUAL_UINT8(0xEE, out[0]);            // nothing written
  TEST_ASSERT_EQUAL_UINT8(0, enc.peek_next_seq());  // seq not advanced on failure
}

// ---------------------------------------------------------------------------
// 9. Garbage before SYNC is counted; the following frame still decodes.
//    Includes a lone 0xAA and the AA AA 55 case.
// ---------------------------------------------------------------------------

void test_garbage_before_sync_counted_then_decoded(void) {
  std::vector<std::uint8_t> frame = build_frame(MessageType::kAck, 4, {0x01, 0x02});
  // 0x00, then a lone 0xAA not followed by 0x55, then 0x01, 0x02 of garbage.
  std::vector<std::uint8_t> stream = {0x00, 0xAA, 0x01, 0x02};
  stream.insert(stream.end(), frame.begin(), frame.end());
  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, stream);
  TEST_ASSERT_EQUAL_UINT32(1, got.size());
  // 0x00 (1) + [0xAA pending, 0x01 not sync -> +2] + 0x02 (1) = 4 garbage bytes.
  TEST_ASSERT_EQUAL_UINT32(4, dec.counters().garbage_bytes);
}

void test_aa_aa_55_prefix_decodes(void) {
  std::vector<std::uint8_t> frame = build_frame(MessageType::kInfo, 1, {0x09});
  std::vector<std::uint8_t> stream = {0xAA};  // extra leading 0xAA -> AA AA 55...
  stream.insert(stream.end(), frame.begin(), frame.end());
  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, stream);
  TEST_ASSERT_EQUAL_UINT32(1, got.size());
  TEST_ASSERT_EQUAL_UINT32(1, dec.counters().garbage_bytes);  // the surplus 0xAA
}

// ---------------------------------------------------------------------------
// 10. A truncated frame followed by valid frames: counted and discarded, and a
//     later valid frame is still emitted (assert fail-safe semantics, NOT a
//     fragile exact-victim count).
// ---------------------------------------------------------------------------

void test_truncated_then_valid_still_recovers(void) {
  std::vector<std::uint8_t> a = build_frame(MessageType::kStatus, 1, {1, 2, 3, 4, 5, 6});
  std::vector<std::uint8_t> truncated(a.begin(), a.end() - 2);  // cut mid-CRC
  std::vector<std::uint8_t> b = build_frame(MessageType::kEvent, 2, {0x42});
  std::vector<std::uint8_t> c = build_frame(MessageType::kCmd, 3, {0x07, 0x00});

  std::vector<std::uint8_t> stream;
  stream.insert(stream.end(), truncated.begin(), truncated.end());
  stream.insert(stream.end(), b.begin(), b.end());
  stream.insert(stream.end(), c.begin(), c.end());

  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, stream);
  TEST_ASSERT_TRUE(got.size() >= 1);              // at least one valid frame survives
  TEST_ASSERT_TRUE(dec.counters().resyncs >= 1);  // the truncation was noticed
  // The LAST valid frame in the stream must always be recovered.
  TEST_ASSERT_EQUAL_UINT8(static_cast<std::uint8_t>(MessageType::kCmd),
                          static_cast<std::uint8_t>(got.back().type));
}

// ---------------------------------------------------------------------------
// 11. Byte-at-a-time delivery emits exactly one frame on the FINAL byte; and the
//     same fixture buffered vs split yields identical frames and identical
//     counters (push_bytes is implemented purely in terms of push_byte).
// ---------------------------------------------------------------------------

void test_byte_at_a_time_emits_once_on_final_byte(void) {
  std::vector<std::uint8_t> frame =
      build_frame(MessageType::kInfo, 8, {0xDE, 0xAD, 0xBE, 0xEF});
  FrameDecoder dec;
  int emitted = 0;
  std::size_t emit_index = 0;
  for (std::size_t i = 0; i < frame.size(); ++i) {
    DecodedFrame out;
    if (dec.push_byte(frame[i], out)) {
      ++emitted;
      emit_index = i;
    }
  }
  TEST_ASSERT_EQUAL_INT(1, emitted);
  TEST_ASSERT_EQUAL_UINT32(frame.size() - 1, emit_index);  // on the very last byte
}

void test_buffered_vs_split_identical(void) {
  std::vector<std::uint8_t> f1 = build_frame(MessageType::kStatus, 10, {1, 2, 3});
  std::vector<std::uint8_t> f2 = build_frame(MessageType::kEvent, 11, {0xAA, 0x55});
  std::vector<std::uint8_t> stream;
  stream.insert(stream.end(), f1.begin(), f1.end());
  stream.insert(stream.end(), f2.begin(), f2.end());

  FrameDecoder buffered;
  std::vector<Captured> got_buf = decode_all(buffered, stream);

  FrameDecoder split;
  std::vector<Captured> got_split;
  for (std::uint8_t b : stream) {
    DecodedFrame out;
    if (split.push_byte(b, out)) {
      Captured c;
      c.type = out.type;
      c.seq = out.seq;
      c.payload.assign(out.payload, out.payload + out.len);
      got_split.push_back(c);
    }
  }

  TEST_ASSERT_EQUAL_UINT32(got_buf.size(), got_split.size());
  TEST_ASSERT_EQUAL_UINT32(2, got_buf.size());
  for (std::size_t i = 0; i < got_buf.size(); ++i) {
    TEST_ASSERT_EQUAL_UINT8(static_cast<std::uint8_t>(got_buf[i].type),
                            static_cast<std::uint8_t>(got_split[i].type));
    TEST_ASSERT_EQUAL_UINT8(got_buf[i].seq, got_split[i].seq);
    TEST_ASSERT_EQUAL_UINT32(got_buf[i].payload.size(), got_split[i].payload.size());
    TEST_ASSERT_EQUAL_UINT8_ARRAY(got_buf[i].payload.data(), got_split[i].payload.data(),
                                  got_buf[i].payload.size());
  }
  // Counters must match byte-for-byte between the two delivery styles.
  TEST_ASSERT_EQUAL_UINT32(buffered.counters().frames_ok, split.counters().frames_ok);
  TEST_ASSERT_EQUAL_UINT32(buffered.counters().garbage_bytes, split.counters().garbage_bytes);
  TEST_ASSERT_EQUAL_UINT32(buffered.counters().bad_crc, split.counters().bad_crc);
}

// ---------------------------------------------------------------------------
// 12. Priority EVENT frames are never coalesced into or downgraded to STATUS.
// ---------------------------------------------------------------------------

void test_event_not_coalesced_with_status(void) {
  const std::uint8_t event_payload[] = {0x01, 0x80};
  const std::uint8_t status_payload[] = {0x00, 0x01, 0x02};
  FrameEncoder enc;
  std::uint8_t buf[kMaxFrameLen * 2];
  const std::size_t n1 =
      enc.encode(MessageType::kEvent, event_payload, 2, buf, sizeof(buf));
  const std::size_t n2 =
      enc.encode(MessageType::kStatus, status_payload, 3, buf + n1, sizeof(buf) - n1);
  std::vector<std::uint8_t> stream(buf, buf + n1 + n2);

  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, stream);
  TEST_ASSERT_EQUAL_UINT32(2, got.size());
  TEST_ASSERT_EQUAL_UINT8(static_cast<std::uint8_t>(MessageType::kEvent),
                          static_cast<std::uint8_t>(got[0].type));
  TEST_ASSERT_EQUAL_UINT8(static_cast<std::uint8_t>(MessageType::kStatus),
                          static_cast<std::uint8_t>(got[1].type));
}

// ---------------------------------------------------------------------------
// 13. Oversized LEN (AA 55 FF ...) -> bad_length, no over-read; a following valid
//     frame still decodes.
// ---------------------------------------------------------------------------

void test_oversized_length_rejected_then_recovers(void) {
  std::vector<std::uint8_t> stream = {kSync0, kSync1, 0xFF, 0x02, 0x03, 0x04, 0x05};
  std::vector<std::uint8_t> valid = build_frame(MessageType::kInfo, 6, {0x77, 0x88});
  stream.insert(stream.end(), valid.begin(), valid.end());

  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, stream);
  TEST_ASSERT_EQUAL_UINT32(1, dec.counters().bad_length);
  TEST_ASSERT_EQUAL_UINT32(1, got.size());
  TEST_ASSERT_EQUAL_UINT8(static_cast<std::uint8_t>(MessageType::kInfo),
                          static_cast<std::uint8_t>(got[0].type));
  TEST_ASSERT_EQUAL_UINT8(6, got[0].seq);
}

// ---------------------------------------------------------------------------
// 14. Sequence wrap: 257 frames -> seq ...255, 0, 1; decoder reports seq intact.
// ---------------------------------------------------------------------------

void test_sequence_wraps_255_to_0(void) {
  FrameEncoder enc;
  std::vector<std::uint8_t> stream;
  for (int i = 0; i < 257; ++i) {
    TEST_ASSERT_EQUAL_UINT8(static_cast<std::uint8_t>(i & 0xFF), enc.peek_next_seq());
    std::vector<std::uint8_t> f =
        encode_one(enc, MessageType::kStatus, {static_cast<std::uint8_t>(i)});
    stream.insert(stream.end(), f.begin(), f.end());
  }
  FrameDecoder dec;
  std::vector<Captured> got = decode_all(dec, stream);
  TEST_ASSERT_EQUAL_UINT32(257, got.size());
  TEST_ASSERT_EQUAL_UINT8(0, got[0].seq);
  TEST_ASSERT_EQUAL_UINT8(255, got[255].seq);
  TEST_ASSERT_EQUAL_UINT8(0, got[256].seq);
}

// ---------------------------------------------------------------------------
// 15. encode() with insufficient out_cap returns 0 and writes nothing.
// ---------------------------------------------------------------------------

void test_encode_insufficient_capacity_writes_nothing(void) {
  const std::uint8_t payload[] = {0xDE, 0xAD};  // needs 7 + 2 = 9 bytes
  std::uint8_t out[9];
  for (std::size_t i = 0; i < sizeof(out); ++i) {
    out[i] = 0x5A;  // sentinel
  }
  FrameEncoder enc;
  const std::size_t n = enc.encode(MessageType::kEvent, payload, 2, out, 8);  // one too few
  TEST_ASSERT_EQUAL_UINT32(0, n);
  for (std::size_t i = 0; i < sizeof(out); ++i) {
    TEST_ASSERT_EQUAL_UINT8(0x5A, out[i]);  // untouched
  }
  TEST_ASSERT_EQUAL_UINT8(0, enc.peek_next_seq());  // seq not advanced

  // Exactly enough room succeeds.
  const std::size_t ok = enc.encode(MessageType::kEvent, payload, 2, out, 9);
  TEST_ASSERT_EQUAL_UINT32(9, ok);
}

// ---------------------------------------------------------------------------
// 16. reset() returns to sync search mid-frame and leaves counters untouched.
// ---------------------------------------------------------------------------

void test_reset_returns_to_sync_and_preserves_counters(void) {
  FrameDecoder dec;
  // Accrue some garbage and one good frame so counters are non-zero.
  std::vector<std::uint8_t> f1 = build_frame(MessageType::kInfo, 1, {0x01});
  std::vector<std::uint8_t> pre = {0x11, 0x22};  // 2 garbage bytes
  pre.insert(pre.end(), f1.begin(), f1.end());
  decode_all(dec, pre);
  const std::uint32_t frames_before = dec.counters().frames_ok;
  const std::uint32_t garbage_before = dec.counters().garbage_bytes;
  TEST_ASSERT_EQUAL_UINT32(1, frames_before);
  TEST_ASSERT_EQUAL_UINT32(2, garbage_before);

  // Feed a partial frame, then reset mid-frame.
  std::vector<std::uint8_t> f2 = build_frame(MessageType::kStatus, 2, {0xAA, 0xBB, 0xCC});
  DecodedFrame out;
  for (std::size_t i = 0; i < 4; ++i) {  // SYNC0,SYNC1,LEN,TYPE — mid-frame
    dec.push_byte(f2[i], out);
  }
  dec.reset();
  // Counters must be untouched by reset().
  TEST_ASSERT_EQUAL_UINT32(frames_before, dec.counters().frames_ok);
  TEST_ASSERT_EQUAL_UINT32(garbage_before, dec.counters().garbage_bytes);

  // A fresh full frame after reset decodes correctly (state is back to kSync0).
  std::vector<Captured> got = decode_all(dec, f2);
  TEST_ASSERT_EQUAL_UINT32(1, got.size());
  TEST_ASSERT_EQUAL_UINT8(2, got[0].seq);
  TEST_ASSERT_EQUAL_UINT32(frames_before + 1, dec.counters().frames_ok);
}

void setUp(void) {}
void tearDown(void) {}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_crc_known_answer_123456789);
  RUN_TEST(test_crc_worked_frame_vectors);
  RUN_TEST(test_worked_full_frame_bytes_match);
  RUN_TEST(test_crc_null_and_empty_is_init_value);
  RUN_TEST(test_crc_streaming_matches_oneshot);
  RUN_TEST(test_roundtrip_hello);
  RUN_TEST(test_roundtrip_info);
  RUN_TEST(test_roundtrip_status);
  RUN_TEST(test_roundtrip_event);
  RUN_TEST(test_roundtrip_cmd);
  RUN_TEST(test_roundtrip_ack);
  RUN_TEST(test_message_type_enum_values);
  RUN_TEST(test_every_truncated_prefix_emits_nothing);
  RUN_TEST(test_every_payload_bit_flip_rejected);
  RUN_TEST(test_corrupt_crc_field_rejected);
  RUN_TEST(test_sequence_observed_never_rejected);
  RUN_TEST(test_framing_bytes_in_payload_roundtrip);
  RUN_TEST(test_zero_and_max_length_payload_roundtrip);
  RUN_TEST(test_encode_rejects_oversized_payload);
  RUN_TEST(test_garbage_before_sync_counted_then_decoded);
  RUN_TEST(test_aa_aa_55_prefix_decodes);
  RUN_TEST(test_truncated_then_valid_still_recovers);
  RUN_TEST(test_byte_at_a_time_emits_once_on_final_byte);
  RUN_TEST(test_buffered_vs_split_identical);
  RUN_TEST(test_event_not_coalesced_with_status);
  RUN_TEST(test_oversized_length_rejected_then_recovers);
  RUN_TEST(test_sequence_wraps_255_to_0);
  RUN_TEST(test_encode_insufficient_capacity_writes_nothing);
  RUN_TEST(test_reset_returns_to_sync_and_preserves_counters);
  return UNITY_END();
}
