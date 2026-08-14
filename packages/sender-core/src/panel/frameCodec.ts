/**
 * Panel serial frame codec (Pi side, issue #55): CRC-16/CCITT-FALSE, the
 * {@link PanelFrameEncoder}, and the incremental {@link PanelFrameDecoder}.
 *
 * This is the TypeScript counterpart of the ESP32 firmware codec in
 * `firmware/panel/src/frame.cpp` (issue #54). It is a byte-for-byte behavioural
 * mirror of that decoder — including its exact garbage-byte accounting and its
 * "observe SEQ, never reject" policy — so both ends of the link agree on every
 * framing decision. The wire format itself is defined in `frameTypes.ts`, which
 * mirrors `frame_types.h`.
 *
 * SAFETY POSTURE (this transport carries the deadman switch and E-stop signals):
 *   * Corrupted input can NEVER cause a payload to be surfaced as valid. Every
 *     failure mode is "reject and count", never "guess".
 *   * The decoder never throws and never hangs: O(1) work per byte, a FIXED
 *     64-byte payload buffer, and NO unbounded array accumulation. An unbounded
 *     stream of garbage grows no buffer — it only advances counters.
 *
 * DELIBERATE DIVERGENCE FROM THE C API. `frame.cpp` hands the sink a payload
 * pointer INTO its reusable internal buffer, valid only until the next byte.
 * That aliasing is a footgun in JavaScript, where a retained view would silently
 * mutate under the consumer. So every {@link DecodedPanelFrame} this decoder
 * emits carries a FRESH COPY of its payload bytes. The framing behaviour is
 * identical; only the ownership of the emitted bytes differs, and safely so.
 *
 * SEQUENCE-GAP ACCOUNTING (Pi-side addition). The firmware decoder only observes
 * SEQ. The Pi decoder additionally REPORTS gaps (it still never rejects): for
 * each CRC-valid frame it computes how many sequence numbers were skipped since
 * the previous CRC-valid frame and surfaces that per-frame and as a running
 * `framesLost` counter. Report, never reject — a gap must never drop an intact
 * E-stop/deadman EVENT.
 */

import {
  PANEL_MAX_PAYLOAD_LEN,
  PANEL_FRAME_OVERHEAD,
  PANEL_SYNC0,
  PANEL_SYNC1,
  PanelMessageType,
} from './frameTypes.js';

// -----------------------------------------------------------------------------
// CRC-16/CCITT-FALSE — ONE definition of the algorithm.
// -----------------------------------------------------------------------------
// Poly 0x1021, Init 0xFFFF, RefIn false, RefOut false, XorOut 0x0000.
// Known answer: crc16CcittFalse("123456789" bytes) === 0x29B1.
//
// The single-byte step is exported-in-spirit through both the one-shot function
// and the streaming decoder so there is exactly ONE algorithm definition, mirror
// of `crc16_step` in frame.cpp (the tests assert streaming === one-shot).

/**
 * Fold one byte into a running CRC-16/CCITT-FALSE register. All arithmetic is
 * masked to 16 bits because JS numbers are 64-bit floats / 32-bit for bitwise
 * ops — without the `& 0xffff` the register would grow past 16 bits.
 */
function crc16Step(crc: number, b: number): number {
  crc = (crc ^ ((b & 0xff) << 8)) & 0xffff;
  for (let i = 0; i < 8; i++) {
    if ((crc & 0x8000) !== 0) {
      crc = ((crc << 1) ^ 0x1021) & 0xffff;
    } else {
      crc = (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * One-shot CRC-16/CCITT-FALSE over `bytes`. An empty range yields the init value
 * 0xFFFF (matching frame.cpp's null/zero-length behaviour).
 */
export function crc16CcittFalse(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crc16Step(crc, bytes[i] as number);
  }
  return crc;
}

// -----------------------------------------------------------------------------
// Encoder
// -----------------------------------------------------------------------------

/**
 * The result of {@link PanelFrameEncoder.encode}: a fresh frame on success, or a
 * reason on failure. Encoding NEVER throws (mirrors the "reject and count"
 * posture): an oversized payload is a reported failure, not an exception.
 */
export type PanelEncodeResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/**
 * Encodes (type, payload) into one framed byte sequence and stamps an
 * auto-incrementing uint8 sequence number.
 *
 * Structural guarantee (mirrors frame.cpp): `encode` emits exactly ONE frame of
 * exactly the type passed. There is no queue and no type-rewriting path, so an
 * EVENT frame can never be coalesced with or downgraded into a STATUS frame.
 */
export class PanelFrameEncoder {
  // The sequence number the NEXT successful encode() will stamp. uint8, wraps.
  #nextSeq = 0;

  /** The sequence number the next successful {@link encode} will stamp. */
  peekNextSeq(): number {
    return this.#nextSeq;
  }

  /**
   * Encode one frame. Stamps the current sequence number, then increments it
   * (wrap 255 -> 0) ONLY on success. Rejects a payload longer than
   * `PANEL_MAX_PAYLOAD_LEN` by returning a failure result rather than throwing.
   * Returns a FRESH `Uint8Array` of exactly `PANEL_FRAME_OVERHEAD + LEN` bytes.
   */
  encode(type: PanelMessageType, payload: Uint8Array = new Uint8Array(0)): PanelEncodeResult {
    const len = payload.length;
    if (len > PANEL_MAX_PAYLOAD_LEN) {
      return {
        ok: false,
        reason: `payload length ${String(len)} exceeds max ${String(PANEL_MAX_PAYLOAD_LEN)}`,
      };
    }

    const total = PANEL_FRAME_OVERHEAD + len;
    const out = new Uint8Array(total);
    out[0] = PANEL_SYNC0;
    out[1] = PANEL_SYNC1;
    out[2] = len & 0xff;
    out[3] = type & 0xff;
    out[4] = this.#nextSeq;
    out.set(payload, 5);

    // CRC covers the contiguous LEN, TYPE, SEQ, PAYLOAD region (out[2 .. 4+len]),
    // never the SYNC bytes and never the CRC field itself.
    const crc = crc16CcittFalse(out.subarray(2, 5 + len));
    out[5 + len] = (crc >> 8) & 0xff; // CRC_HI (big-endian on the wire)
    out[6 + len] = crc & 0xff; // CRC_LO

    // Auto-increment only on success; uint8 wraps 255 -> 0.
    this.#nextSeq = (this.#nextSeq + 1) & 0xff;
    return { ok: true, bytes: out };
  }
}

// -----------------------------------------------------------------------------
// Decoder
// -----------------------------------------------------------------------------

/**
 * A frame emitted by {@link PanelFrameDecoder}. `payload` is a FRESH COPY owned
 * by the caller (see the deliberate divergence from the C API in the file
 * header) — retaining or mutating it is safe.
 */
export interface DecodedPanelFrame {
  /** The raw TYPE byte from the wire. May be an unknown type: the decoder
   *  observes it and never rejects on type (mirrors firmware policy). */
  type: number;
  /** The raw SEQ byte from the wire. */
  seq: number;
  /** A fresh copy of the LEN payload bytes (0..64). */
  payload: Uint8Array;
  /** How many sequence numbers were skipped since the previous CRC-valid frame.
   *  0 for the first frame and for a normal 255 -> 0 wrap. */
  framesLostBefore: number;
}

/**
 * Observable decoder diagnostics. Mirrors `DecoderCounters` in frame.h, plus the
 * Pi-only `framesLost` sequence-gap total. Monotonic; survive {@link
 * PanelFrameDecoder.reset}.
 */
export interface PanelDecoderCounters {
  /** CRC-valid frames emitted. */
  framesOk: number;
  /** CRC mismatches: frame discarded. */
  badCrc: number;
  /** LEN > 64: frame rejected before any payload buffering. */
  badLength: number;
  /** Bytes discarded while hunting for the SYNC anchor. */
  garbageBytes: number;
  /** Re-entries to SYNC search after a bad length or bad CRC. */
  resyncs: number;
  /** Total sequence numbers reported skipped across all CRC-valid frames. */
  framesLost: number;
}

// Wire-order decoder states, mirror of frame.cpp's State enum. Modelled as a
// plain const object (not a TS `enum`/`const enum`, which are unsafe under this
// repo's `isolatedModules` + `verbatimModuleSyntax` settings).
const DecoderState = {
  Sync0: 0, // hunting for 0xAA
  Sync1: 1, // saw 0xAA, expect 0x55
  Len: 2, // expect LEN
  Type: 3, // expect TYPE
  Seq: 4, // expect SEQ
  Payload: 5, // gathering exactly LEN payload bytes
  CrcHi: 6, // expect CRC high byte
  CrcLo: 7, // expect CRC low byte
} as const;

type DecoderState = (typeof DecoderState)[keyof typeof DecoderState];

/**
 * Incremental, byte-at-a-time panel frame decoder. Feed bytes in any chunking;
 * completed CRC-valid frames are returned (and optionally delivered to a sink).
 *
 * O(1) work per byte, a FIXED 64-byte payload buffer, never throws, never hangs.
 */
export class PanelFrameDecoder {
  #state: DecoderState = DecoderState.Sync0;
  #len = 0; // declared payload length for the in-flight frame
  #payloadPos = 0; // payload bytes gathered so far (0..len)
  #type = 0; // in-flight TYPE byte
  #seq = 0; // in-flight SEQ byte
  #crcCalc = 0; // CRC accumulated over LEN, TYPE, SEQ, PAYLOAD
  #crcRecv = 0; // CRC received from the wire (big-endian)

  // Fixed payload buffer — NEVER grows. Oversized LEN is rejected before we ever
  // index into this, so an over-read/overflow is structurally impossible.
  readonly #payload = new Uint8Array(PANEL_MAX_PAYLOAD_LEN);

  // Last CRC-valid SEQ, for gap accounting. null until the first valid frame (or
  // after sequence tracking is reset) so the first frame reports no gap.
  #lastSeq: number | null = null;

  readonly #counters: PanelDecoderCounters = {
    framesOk: 0,
    badCrc: 0,
    badLength: 0,
    garbageBytes: 0,
    resyncs: 0,
    framesLost: 0,
  };

  /** A read-only snapshot of the diagnostics counters. */
  get counters(): Readonly<PanelDecoderCounters> {
    return { ...this.#counters };
  }

  /**
   * The number of payload bytes currently buffered for the in-flight frame
   * (0..64). Exposed so tests can assert the decoder's memory is bounded even
   * under an unbounded garbage stream — it can never exceed
   * `PANEL_MAX_PAYLOAD_LEN`.
   */
  get bufferedByteCount(): number {
    return this.#payloadPos;
  }

  /**
   * Return to SYNC search and clear the in-flight working state. Counters AND
   * sequence-gap tracking are left UNTOUCHED (they are persistent diagnostics,
   * exactly like frame.cpp's reset): a resync mid-stream must not fabricate a
   * false "first frame, no gap" for the frame that follows.
   */
  reset(): void {
    this.#state = DecoderState.Sync0;
    this.#len = 0;
    this.#payloadPos = 0;
    this.#crcCalc = 0;
    this.#crcRecv = 0;
  }

  /**
   * Feed a chunk of bytes. Returns every completed CRC-valid frame in order and,
   * if a `sink` is given, invokes it once per completed frame. Implemented PURELY
   * over {@link pushByte}, so "one byte at a time" and "one big buffer" are
   * literally the same code path (matches frame.cpp's push_bytes/push_byte
   * coupling). A `sink` is NEVER invoked for a bad-CRC / bad-length frame.
   */
  push(chunk: Uint8Array, sink?: (frame: DecodedPanelFrame) => void): DecodedPanelFrame[] {
    const frames: DecodedPanelFrame[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const frame = this.pushByte(chunk[i] as number);
      if (frame !== null) {
        frames.push(frame);
        if (sink !== undefined) {
          sink(frame);
        }
      }
    }
    return frames;
  }

  /**
   * Push exactly one byte. Returns a completed frame iff this byte finished a
   * CRC-valid frame, else `null`. This is the single code path all decoding
   * flows through. Never throws.
   */
  pushByte(byte: number): DecodedPanelFrame | null {
    const b = byte & 0xff;
    switch (this.#state) {
      case DecoderState.Sync0:
        // Hunt for SYNC0. Any non-0xAA byte is garbage. The 0xAA itself is NOT
        // yet counted — it may be a real SYNC0.
        if (b === PANEL_SYNC0) {
          this.#state = DecoderState.Sync1;
        } else {
          this.#counters.garbageBytes++;
        }
        return null;

      case DecoderState.Sync1:
        if (b === PANEL_SYNC1) {
          // Valid 0xAA 0x55 anchor: the pending 0xAA was a real SYNC0.
          this.#state = DecoderState.Len;
        } else if (b === PANEL_SYNC0) {
          // 0xAA 0xAA...: the pending 0xAA was garbage (+1), but this new 0xAA
          // could be the real SYNC0, so stay here and count only the discarded.
          this.#counters.garbageBytes++;
        } else {
          // Pending 0xAA and this byte are BOTH garbage (+2); resume SYNC0 hunt.
          this.#counters.garbageBytes += 2;
          this.#state = DecoderState.Sync0;
        }
        return null;

      case DecoderState.Len:
        // Reject an oversized length BEFORE buffering any payload, so it can
        // never cause an over-read or overflow.
        if (b > PANEL_MAX_PAYLOAD_LEN) {
          this.#counters.badLength++;
          this.#counters.resyncs++;
          this.#state = DecoderState.Sync0;
          return null;
        }
        this.#len = b;
        this.#payloadPos = 0;
        // CRC covers LEN, TYPE, SEQ, PAYLOAD (never SYNC or the CRC field).
        this.#crcCalc = crc16Step(0xffff, this.#len);
        this.#state = DecoderState.Type;
        return null;

      case DecoderState.Type:
        this.#type = b;
        this.#crcCalc = crc16Step(this.#crcCalc, b);
        this.#state = DecoderState.Seq;
        return null;

      case DecoderState.Seq:
        this.#seq = b;
        this.#crcCalc = crc16Step(this.#crcCalc, b);
        // LEN == 0 frames carry no payload: jump straight to the CRC.
        this.#state = this.#len === 0 ? DecoderState.CrcHi : DecoderState.Payload;
        return null;

      case DecoderState.Payload:
        this.#payload[this.#payloadPos] = b;
        this.#payloadPos++;
        this.#crcCalc = crc16Step(this.#crcCalc, b);
        if (this.#payloadPos >= this.#len) {
          this.#state = DecoderState.CrcHi;
        }
        return null;

      case DecoderState.CrcHi:
        this.#crcRecv = (b << 8) & 0xffff;
        this.#state = DecoderState.CrcLo;
        return null;

      case DecoderState.CrcLo:
        this.#crcRecv = (this.#crcRecv | b) & 0xffff;
        this.#state = DecoderState.Sync0;
        if (this.#crcRecv === this.#crcCalc) {
          return this.#emitValidFrame();
        }
        // CRC mismatch: discard, count, resynchronise. Never act on the payload,
        // never invoke a sink for it.
        this.#counters.badCrc++;
        this.#counters.resyncs++;
        return null;
    }
    // Unreachable: every state is handled above. Fail safe to SYNC search.
    this.#state = DecoderState.Sync0;
    return null;
  }

  /**
   * Assemble and account a CRC-valid frame: copy the payload out (no aliasing),
   * compute the sequence gap, and advance counters.
   */
  #emitValidFrame(): DecodedPanelFrame {
    // Fresh copy so the caller owns the bytes independent of the reusable buffer.
    const payload = this.#payload.slice(0, this.#len);

    // Sequence-gap accounting over CRC-valid frames only. First valid frame (or
    // first after sequence tracking is cleared) reports no gap. A normal wrap
    // 255 -> 0 yields (0 - 255 - 1) & 0xFF === 0 (no false gap).
    let framesLostBefore = 0;
    if (this.#lastSeq !== null) {
      framesLostBefore = (this.#seq - this.#lastSeq - 1) & 0xff;
    }
    this.#lastSeq = this.#seq;
    this.#counters.framesLost += framesLostBefore;
    this.#counters.framesOk++;

    return { type: this.#type, seq: this.#seq, payload, framesLostBefore };
  }
}
