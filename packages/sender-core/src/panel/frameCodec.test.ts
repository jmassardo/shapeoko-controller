/**
 * Tests for the panel frame codec (issue #55): CRC-16/CCITT-FALSE known answers,
 * worked byte-vector parity with the #54 firmware tests, encoder behaviour,
 * seeded round-trip fuzzing, the corrupted-frame corpus, sequence-gap accounting,
 * and the bounded-memory / never-hangs guarantees.
 *
 * Randomness is a hand-rolled SEEDED mulberry32 PRNG (NO fast-check or other
 * dependency), so every fuzz failure is reproducible from the printed seed.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PanelFrameDecoder,
  PanelFrameEncoder,
  crc16CcittFalse,
  type DecodedPanelFrame,
} from './frameCodec.js';
import {
  PANEL_MESSAGE_TYPE_VALUES,
  PANEL_MAX_PAYLOAD_LEN,
  PanelMessageType,
} from './frameTypes.js';

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Deterministic; print the seed on any fuzz failure.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng: () => number, maxExclusive: number): number =>
  Math.floor(rng() * maxExclusive);

/** Build a well-formed frame with an explicit seq (bypasses the encoder so tests
 *  can control seq and then corrupt bytes). Uses the ONE CRC implementation. */
function buildFrame(type: number, seq: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const out = new Uint8Array(7 + len);
  out[0] = 0xaa;
  out[1] = 0x55;
  out[2] = len;
  out[3] = type;
  out[4] = seq;
  out.set(payload, 5);
  const crc = crc16CcittFalse(out.subarray(2, 5 + len));
  out[5 + len] = (crc >> 8) & 0xff;
  out[6 + len] = crc & 0xff;
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRC known answers + worked vectors (parity with #54's test_frame.cpp).
// ---------------------------------------------------------------------------
describe('crc16CcittFalse', () => {
  it('has the normative check value for "123456789"', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc16CcittFalse(bytes)).toBe(0x29b1);
  });

  it('matches the worked frame vectors from #54', () => {
    expect(crc16CcittFalse(Uint8Array.of(0x02, 0x03, 0x01, 0xde, 0xad))).toBe(0xab0c);
    expect(crc16CcittFalse(Uint8Array.of(0x00, 0x00, 0x00))).toBe(0xcc9c);
  });

  it('yields the init value 0xFFFF for an empty range', () => {
    expect(crc16CcittFalse(new Uint8Array(0))).toBe(0xffff);
  });

  it('streaming decoder CRC agrees with the one-shot function', () => {
    // The decoder accumulates CRC one byte at a time; a frame built with the
    // one-shot CRC decodes cleanly, and a one-bit CRC change is rejected.
    const frame = buildFrame(PanelMessageType.Info, 7, Uint8Array.of(1, 2, 3, 4));
    const dec = new PanelFrameDecoder();
    expect(dec.push(frame).length).toBe(1);

    const bad = frame.slice();
    bad[bad.length - 1] ^= 0x01;
    const dec2 = new PanelFrameDecoder();
    expect(dec2.push(bad).length).toBe(0);
    expect(dec2.counters.badCrc).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Worked full-frame byte parity: the encoder must produce the exact bytes the
// #54 host tests hard-code (including the CRC bytes).
// ---------------------------------------------------------------------------
describe('PanelFrameEncoder byte-vector parity with #54', () => {
  it('encodes HELLO(seq 0, empty) then EVENT(seq 1, DE AD) to the worked vectors', () => {
    const enc = new PanelFrameEncoder();

    const hello = enc.encode(PanelMessageType.Hello);
    expect(hello.ok).toBe(true);
    if (hello.ok) {
      // AA 55 00 00 00 CC 9C
      expect([...hello.bytes]).toEqual([0xaa, 0x55, 0x00, 0x00, 0x00, 0xcc, 0x9c]);
    }

    const event = enc.encode(PanelMessageType.Event, Uint8Array.of(0xde, 0xad));
    expect(event.ok).toBe(true);
    if (event.ok) {
      // AA 55 02 03 01 DE AD AB 0C
      expect([...event.bytes]).toEqual([0xaa, 0x55, 0x02, 0x03, 0x01, 0xde, 0xad, 0xab, 0x0c]);
    }
  });
});

describe('PanelFrameEncoder', () => {
  it('auto-increments seq on success only and exposes peekNextSeq', () => {
    const enc = new PanelFrameEncoder();
    expect(enc.peekNextSeq()).toBe(0);
    enc.encode(PanelMessageType.Status, Uint8Array.of(1));
    expect(enc.peekNextSeq()).toBe(1);
    enc.encode(PanelMessageType.Status, Uint8Array.of(2));
    expect(enc.peekNextSeq()).toBe(2);
  });

  it('does not advance seq when encoding fails (oversized payload)', () => {
    const enc = new PanelFrameEncoder();
    const res = enc.encode(PanelMessageType.Status, new Uint8Array(PANEL_MAX_PAYLOAD_LEN + 1));
    expect(res.ok).toBe(false);
    expect(enc.peekNextSeq()).toBe(0);
  });

  it('wraps seq 255 -> 0', () => {
    const enc = new PanelFrameEncoder();
    // Advance to 255 by encoding 255 empty frames.
    for (let i = 0; i < 255; i++) {
      enc.encode(PanelMessageType.Hello);
    }
    expect(enc.peekNextSeq()).toBe(255);
    const wrap = enc.encode(PanelMessageType.Hello);
    expect(wrap.ok).toBe(true);
    if (wrap.ok) {
      expect(wrap.bytes[4]).toBe(255); // this frame stamped 255
    }
    expect(enc.peekNextSeq()).toBe(0); // wrapped
  });

  it('returns a fresh buffer of exactly 7 + LEN bytes', () => {
    const enc = new PanelFrameEncoder();
    for (const len of [0, 1, 32, PANEL_MAX_PAYLOAD_LEN]) {
      const res = enc.encode(PanelMessageType.Status, new Uint8Array(len));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.bytes.length).toBe(7 + len);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip fuzz: every message type, payload lengths 0..64 (both boundaries),
// payloads with 0xAA/0x55 runs. Re-chunk the same stream randomly and assert
// identical results.
// ---------------------------------------------------------------------------
describe('round-trip fuzz', () => {
  const SEED = 0x5eed_1234;

  it(
    'preserves type, seq, and payload bytes across encode -> decode and re-chunking',
    { timeout: 20_000 },
    () => {
      const rng = mulberry32(SEED);
      const enc = new PanelFrameEncoder();

      interface Sent {
        type: number;
        seq: number;
        payload: Uint8Array;
      }
      const sent: Sent[] = [];
      const wire: Uint8Array[] = [];

      const ITER = 400;
      for (let i = 0; i < ITER; i++) {
        const type = PANEL_MESSAGE_TYPE_VALUES[
          randInt(rng, PANEL_MESSAGE_TYPE_VALUES.length)
        ] as number;
        const len = randInt(rng, PANEL_MAX_PAYLOAD_LEN + 1); // 0..64 inclusive
        const payload = new Uint8Array(len);
        for (let j = 0; j < len; j++) {
          // Bias heavily toward 0xAA / 0x55 so SYNC-lookalike runs are common.
          const r = rng();
          payload[j] = r < 0.25 ? 0xaa : r < 0.5 ? 0x55 : randInt(rng, 256);
        }
        const seq = enc.peekNextSeq();
        const res = enc.encode(type, payload);
        expect(res.ok).toBe(true);
        if (res.ok) {
          sent.push({ type, seq, payload });
          wire.push(res.bytes);
        }
      }

      const stream = concatBytes(wire);

      // (a) One big buffer.
      const decAll = new PanelFrameDecoder();
      const gotAll = decAll.push(stream);

      // (b) Randomly re-chunked at arbitrary boundaries.
      const decChunked = new PanelFrameDecoder();
      const gotChunked: DecodedPanelFrame[] = [];
      let pos = 0;
      while (pos < stream.length) {
        const size = 1 + randInt(rng, 17);
        const chunk = stream.subarray(pos, Math.min(pos + size, stream.length));
        for (const f of decChunked.push(chunk)) {
          gotChunked.push(f);
        }
        pos += size;
      }

      const check = (got: DecodedPanelFrame[], label: string): void => {
        expect(got.length, `seed=0x${SEED.toString(16)} ${label}: frame count`).toBe(sent.length);
        for (let i = 0; i < sent.length; i++) {
          const s = sent[i] as Sent;
          const g = got[i] as DecodedPanelFrame;
          expect(g.type, `seed=0x${SEED.toString(16)} ${label} frame ${String(i)}: type`).toBe(
            s.type,
          );
          expect(g.seq, `seed=0x${SEED.toString(16)} ${label} frame ${String(i)}: seq`).toBe(s.seq);
          expect(
            [...g.payload],
            `seed=0x${SEED.toString(16)} ${label} frame ${String(i)}: payload`,
          ).toEqual([...s.payload]);
        }
      };

      check(gotAll, 'buffered');
      check(gotChunked, 'chunked');
      // Both paths must agree exactly (push_bytes == repeated push_byte).
      expect(gotChunked.map((f) => f.seq)).toEqual(gotAll.map((f) => f.seq));
    },
  );

  it('round-trips a max-length payload of all 0xAA then all 0x55 bytes', () => {
    const enc = new PanelFrameEncoder();
    for (const fill of [0xaa, 0x55]) {
      const payload = new Uint8Array(PANEL_MAX_PAYLOAD_LEN).fill(fill);
      const res = enc.encode(PanelMessageType.Status, payload);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const got = new PanelFrameDecoder().push(res.bytes);
        expect(got.length).toBe(1);
        expect([...(got[0] as DecodedPanelFrame).payload]).toEqual([...payload]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Corrupted corpus: the decoder never throws, counts the error, discards the
// payload (no sink fires), resynchronises, and decodes the NEXT good frame.
// ---------------------------------------------------------------------------
describe('corrupted-frame corpus', () => {
  const good = (): Uint8Array => buildFrame(PanelMessageType.Cmd, 9, Uint8Array.of(0x07, 0x00));

  it('rejects a flipped CRC_HI, counts badCrc, fires no sink, then recovers', () => {
    const bad = buildFrame(PanelMessageType.Status, 1, Uint8Array.of(1, 2, 3, 4));
    bad[bad.length - 2] ^= 0xff; // CRC_HI
    const dec = new PanelFrameDecoder();
    const sink = vi.fn();
    dec.push(bad, sink);
    expect(dec.counters.badCrc).toBe(1);
    expect(dec.counters.resyncs).toBe(1);
    expect(sink).not.toHaveBeenCalled();
    // Next good frame still decodes.
    const got = dec.push(good(), sink);
    expect(got.length).toBe(1);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('rejects a flipped CRC_LO, counts badCrc, then recovers', () => {
    const bad = buildFrame(PanelMessageType.Status, 1, Uint8Array.of(1, 2, 3, 4));
    bad[bad.length - 1] ^= 0xff; // CRC_LO
    const dec = new PanelFrameDecoder();
    const sink = vi.fn();
    dec.push(bad, sink);
    expect(dec.counters.badCrc).toBe(1);
    expect(sink).not.toHaveBeenCalled();
    expect(dec.push(good()).length).toBe(1);
  });

  it('rejects LEN = 65 BEFORE buffering and recovers on the next frame', () => {
    const dec = new PanelFrameDecoder();
    // AA 55 41(=65) ... garbage; the oversized length is rejected at the LEN byte.
    const stream = concatBytes([Uint8Array.of(0xaa, 0x55, 65, 0x00, 0x00, 0x11, 0x22), good()]);
    const sink = vi.fn();
    const got = dec.push(stream, sink);
    expect(dec.counters.badLength).toBe(1);
    expect(dec.counters.resyncs).toBe(1);
    // The buffer never held payload for the oversized length.
    expect(dec.bufferedByteCount).toBeLessThanOrEqual(PANEL_MAX_PAYLOAD_LEN);
    expect(got.length).toBe(1); // the trailing good frame
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('rejects LEN = 255 as a bad length', () => {
    const dec = new PanelFrameDecoder();
    dec.push(Uint8Array.of(0xaa, 0x55, 255));
    expect(dec.counters.badLength).toBe(1);
    expect(dec.push(good()).length).toBe(1);
  });

  it('discards a truncated (mid-payload) frame yet recovers the following frame', () => {
    const full = buildFrame(PanelMessageType.Status, 1, Uint8Array.of(1, 2, 3, 4, 5, 6));
    const truncated = full.subarray(0, full.length - 2); // cut mid-CRC
    const next = buildFrame(PanelMessageType.Event, 2, Uint8Array.of(0x42));
    const dec = new PanelFrameDecoder();
    const sink = vi.fn();
    const got = dec.push(concatBytes([truncated, next, good()]), sink);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(dec.counters.resyncs).toBeGreaterThanOrEqual(1);
    // The LAST valid frame is always recovered.
    expect((got[got.length - 1] as DecodedPanelFrame).type).toBe(PanelMessageType.Cmd);
  });

  it('counts a lone 0xAA + non-sync as +2 garbage and still decodes (parity with #54)', () => {
    const frame = buildFrame(PanelMessageType.Ack, 4, Uint8Array.of(0x01, 0x02));
    // 0x00 (1) + [0xAA pending, 0x01 not sync -> +2] + 0x02 (1) = 4 garbage bytes.
    const stream = concatBytes([Uint8Array.of(0x00, 0xaa, 0x01, 0x02), frame]);
    const dec = new PanelFrameDecoder();
    const got = dec.push(stream);
    expect(got.length).toBe(1);
    expect(dec.counters.garbageBytes).toBe(4);
  });

  it('counts a surplus leading 0xAA (AA AA 55...) as exactly 1 garbage byte', () => {
    const frame = buildFrame(PanelMessageType.Info, 1, Uint8Array.of(0x09));
    const stream = concatBytes([Uint8Array.of(0xaa), frame]);
    const dec = new PanelFrameDecoder();
    const got = dec.push(stream);
    expect(got.length).toBe(1);
    expect(dec.counters.garbageBytes).toBe(1);
  });

  it('a long run of 0xAA before a frame counts each surplus 0xAA once', () => {
    const frame = buildFrame(PanelMessageType.Info, 1, Uint8Array.of(0x09));
    const run = new Uint8Array(10).fill(0xaa); // 9 surplus + the real SYNC0
    const dec = new PanelFrameDecoder();
    const got = dec.push(concatBytes([run, frame.subarray(1)]));
    // run = 10 0xAA bytes, then 0x55... : first 9 0xAA are surplus (+1 each),
    // the 10th 0xAA is the anchor SYNC0 consumed by the following 0x55.
    expect(got.length).toBe(1);
    expect(dec.counters.garbageBytes).toBe(9);
  });

  it('interleaved partial chunks: a bad frame split across chunks is discarded, next recovers', () => {
    const bad = buildFrame(PanelMessageType.Status, 1, Uint8Array.of(9, 9, 9, 9));
    bad[bad.length - 1] ^= 0xaa; // corrupt CRC
    const stream = concatBytes([bad, good()]);
    const dec = new PanelFrameDecoder();
    const sink = vi.fn();
    const emitted: DecodedPanelFrame[] = [];
    // Feed in awkward 3-byte chunks.
    for (let pos = 0; pos < stream.length; pos += 3) {
      for (const f of dec.push(stream.subarray(pos, pos + 3), sink)) {
        emitted.push(f);
      }
    }
    expect(dec.counters.badCrc).toBe(1);
    expect(emitted.length).toBe(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect((emitted[0] as DecodedPanelFrame).type).toBe(PanelMessageType.Cmd);
  });
});

// ---------------------------------------------------------------------------
// Three-chunk split: exactly one frame after the THIRD chunk; zero before.
// ---------------------------------------------------------------------------
describe('split delivery', () => {
  it('emits exactly one frame after the third chunk and zero for the first two', () => {
    const frame = buildFrame(PanelMessageType.Info, 8, Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    // Split into three non-empty chunks.
    const a = frame.subarray(0, 3);
    const b = frame.subarray(3, 6);
    const c = frame.subarray(6);
    const dec = new PanelFrameDecoder();
    expect(dec.push(a).length).toBe(0);
    expect(dec.push(b).length).toBe(0);
    const got = dec.push(c);
    expect(got.length).toBe(1);
    expect((got[0] as DecodedPanelFrame).seq).toBe(8);
  });

  it('byte-at-a-time emits only on the final byte', () => {
    const frame = buildFrame(PanelMessageType.Info, 8, Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    const dec = new PanelFrameDecoder();
    let emitted = 0;
    let emitIndex = -1;
    for (let i = 0; i < frame.length; i++) {
      const f = dec.pushByte(frame[i] as number);
      if (f !== null) {
        emitted++;
        emitIndex = i;
      }
    }
    expect(emitted).toBe(1);
    expect(emitIndex).toBe(frame.length - 1);
  });

  it('buffered vs split yields identical frames and identical counters', () => {
    const f1 = buildFrame(PanelMessageType.Status, 10, Uint8Array.of(1, 2, 3));
    const f2 = buildFrame(PanelMessageType.Event, 11, Uint8Array.of(0xaa, 0x55));
    const stream = concatBytes([f1, f2]);

    const buffered = new PanelFrameDecoder();
    const gotBuf = buffered.push(stream);

    const split = new PanelFrameDecoder();
    const gotSplit: DecodedPanelFrame[] = [];
    for (const byte of stream) {
      const f = split.pushByte(byte);
      if (f !== null) {
        gotSplit.push(f);
      }
    }

    expect(gotSplit.map((f) => f.seq)).toEqual(gotBuf.map((f) => f.seq));
    expect(split.counters).toEqual(buffered.counters);
  });
});

// ---------------------------------------------------------------------------
// EVENT is never coalesced into STATUS (structural: encode emits exactly the
// type passed).
// ---------------------------------------------------------------------------
describe('EVENT priority is structural', () => {
  it('an EVENT encodes and decodes as EVENT, never STATUS', () => {
    const enc = new PanelFrameEncoder();
    const res = enc.encode(PanelMessageType.Event, Uint8Array.of(0x01, 0x00));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bytes[3]).toBe(PanelMessageType.Event);
      const got = new PanelFrameDecoder().push(res.bytes);
      expect((got[0] as DecodedPanelFrame).type).toBe(PanelMessageType.Event);
    }
  });
});

// ---------------------------------------------------------------------------
// Sequence-gap accounting (report, never reject).
// ---------------------------------------------------------------------------
describe('sequence-gap accounting', () => {
  const decodeSeqs = (seqs: number[]): { frames: DecodedPanelFrame[]; dec: PanelFrameDecoder } => {
    const dec = new PanelFrameDecoder();
    const frames: DecodedPanelFrame[] = [];
    for (const seq of seqs) {
      for (const f of dec.push(buildFrame(PanelMessageType.Status, seq, Uint8Array.of(seq)))) {
        frames.push(f);
      }
    }
    return { frames, dec };
  };

  it('reports no gap for the first frame', () => {
    const { frames } = decodeSeqs([7]);
    expect(frames[0]?.framesLostBefore).toBe(0);
  });

  it('reports no gap for consecutive frames', () => {
    const { frames, dec } = decodeSeqs([5, 6, 7]);
    expect(frames.map((f) => f.framesLostBefore)).toEqual([0, 0, 0]);
    expect(dec.counters.framesLost).toBe(0);
  });

  it('reports 8 lost for a 250 -> 3 jump', () => {
    const { frames, dec } = decodeSeqs([250, 3]);
    expect(frames[1]?.framesLostBefore).toBe(8); // (3 - 250 - 1) & 0xFF
    expect(dec.counters.framesLost).toBe(8);
  });

  it('reports NO false gap across the 255 -> 0 wrap', () => {
    const { frames, dec } = decodeSeqs([254, 255, 0, 1]);
    expect(frames.map((f) => f.framesLostBefore)).toEqual([0, 0, 0, 0]);
    expect(dec.counters.framesLost).toBe(0);
  });

  it('accumulates framesLost across multiple gaps', () => {
    // 0 -> 2 loses 1; 2 -> 5 loses 2; total 3.
    const { frames, dec } = decodeSeqs([0, 2, 5]);
    expect(frames.map((f) => f.framesLostBefore)).toEqual([0, 1, 2]);
    expect(dec.counters.framesLost).toBe(3);
  });

  it('does not count gaps across a bad-CRC frame (only CRC-valid frames advance seq)', () => {
    const dec = new PanelFrameDecoder();
    dec.push(buildFrame(PanelMessageType.Status, 10, Uint8Array.of(1)));
    const bad = buildFrame(PanelMessageType.Status, 11, Uint8Array.of(2));
    bad[bad.length - 1] ^= 0xff;
    dec.push(bad);
    // Next valid frame is seq 12; gap is measured against the last VALID seq 10.
    const got = dec.push(buildFrame(PanelMessageType.Status, 12, Uint8Array.of(3)));
    expect(got[0]?.framesLostBefore).toBe(1); // (12 - 10 - 1) & 0xFF
  });
});

// ---------------------------------------------------------------------------
// Unbounded garbage: bounded memory, rising counters, no throw, still recovers.
// ---------------------------------------------------------------------------
describe('unbounded garbage resilience', () => {
  it(
    'stays bounded and never throws under 200 kB of PRNG garbage, then decodes a valid frame',
    { timeout: 20_000 },
    () => {
      const SEED = 0xabcd_1234;
      const rng = mulberry32(SEED);
      const dec = new PanelFrameDecoder();
      const sink = vi.fn();

      let maxBuffered = 0;
      const CHUNK = 4096;
      const TOTAL = 200 * 1024;
      let fed = 0;
      expect(() => {
        while (fed < TOTAL) {
          const size = Math.min(CHUNK, TOTAL - fed);
          const chunk = new Uint8Array(size);
          for (let i = 0; i < size; i++) {
            chunk[i] = randInt(rng, 256);
          }
          // Feed byte-at-a-time so we can sample the buffered-byte count.
          for (const byte of chunk) {
            dec.pushByte(byte);
            if (dec.bufferedByteCount > maxBuffered) {
              maxBuffered = dec.bufferedByteCount;
            }
          }
          fed += size;
        }
      }).not.toThrow();

      // Memory is bounded: the internal payload buffer never exceeds 64.
      expect(maxBuffered).toBeLessThanOrEqual(PANEL_MAX_PAYLOAD_LEN);
      // Some error accounting must have happened (garbage and/or bad frames).
      const c = dec.counters;
      expect(c.garbageBytes + c.badCrc + c.badLength).toBeGreaterThan(0);

      // A valid frame appended after all that garbage still decodes.
      const got = dec.push(buildFrame(PanelMessageType.Hello, 0, new Uint8Array(0)), sink);
      expect(got.length).toBe(1);
      expect(sink).toHaveBeenCalledTimes(1);
    },
  );
});

// ---------------------------------------------------------------------------
// reset() returns to SYNC hunting, clears working state, preserves counters.
// ---------------------------------------------------------------------------
describe('reset', () => {
  it('preserves counters and abandons the in-flight frame', () => {
    const dec = new PanelFrameDecoder();
    // Decode one good frame so counters are non-zero.
    dec.push(buildFrame(PanelMessageType.Status, 1, Uint8Array.of(1, 2)));
    expect(dec.counters.framesOk).toBe(1);

    // Feed a partial frame, then reset mid-frame.
    const partial = buildFrame(PanelMessageType.Status, 2, Uint8Array.of(3, 4)).subarray(0, 4);
    dec.push(partial);
    expect(dec.bufferedByteCount).toBeGreaterThanOrEqual(0);
    dec.reset();
    expect(dec.bufferedByteCount).toBe(0);

    // Counters survive the reset.
    expect(dec.counters.framesOk).toBe(1);

    // The decoder is back to SYNC hunting: the leftover of the abandoned frame is
    // treated as garbage, and a fresh frame still decodes.
    const got = dec.push(buildFrame(PanelMessageType.Event, 5, Uint8Array.of(0x42)));
    expect(got.length).toBe(1);
    expect(dec.counters.framesOk).toBe(2);
  });
});
